import { message, save } from "@tauri-apps/plugin-dialog";
import { FileDown, FileUp, Loader2, MousePointer2, Plug } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { ImportSource } from "../lib/importers/common";
import { useT } from "../i18n";
import { db, fsx } from "../lib/api";
import { SOURCES } from "./HistoryImport";
import {
  addMessage,
  archiveChat,
  createChat,
  importFromCursor,
  listArchived,
  listChats,
  listProjects,
  loadMessages,
  scanCursor,
  type Chat,
  type ImportProject,
} from "../lib/data";
import {
  buildBundle,
  exportFileName,
  ImportError,
  importBundle,
  parseBundle,
  toJson,
  toMarkdown,
  type ChatStore,
  type ExportFormat,
  type ExportSource,
  type MdLabels,
} from "../lib/exportChats";
import { matchOrCreateProject } from "../lib/importers/store";
import { useApp } from "../state";
import { HistoryImport } from "./HistoryImport";
import { ShareHtmlDialog } from "./ShareHtmlDialog";

type T = ReturnType<typeof useT>;
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e);

/** Markdown headings and tool-card labels in the UI language; `{date}` and `{chars}` are filled in by `toMarkdown`. */
export const mdLabels = (t: T): MdLabels => ({
  exported: t("mdExportedOn", { date: "{date}" }),
  project: t("mdProject"),
  created: t("mdCreated"),
  updated: t("mdUpdated"),
  messages: t("mdMessages"),
  chats: t("mdChats"),
  user: t("mdUser"),
  assistant: t("mdAssistant"),
  toolCall: t("mdToolCall"),
  toolResult: t("mdToolResult"),
  noOutput: t("mdNoOutput"),
  truncated: t("mdTruncated", { chars: "{chars}" }),
  status: {
    running: t("action_running"),
    success: t("action_success"),
    error: t("action_error"),
    unknown: t("action_unknown"),
  },
});

/** Asks where to save with the native dialog, then writes the chats. Resolves to the saved path, or `null` if cancelled. */
export async function exportChatsToFile(
  chats: Chat[],
  format: ExportFormat,
  { includeImages = false, labels }: { includeImages?: boolean; labels: MdLabels },
): Promise<string | null> {
  const ext = format === "json" ? "json" : "md";
  const path = await save({
    defaultPath: exportFileName(
      format,
      chats.map((c) => c.title),
    ),
    filters: [{ name: format === "json" ? "JSON" : "Markdown", extensions: [ext] }],
  });
  if (!path) return null;
  const projects = new Map((await listProjects()).map((p) => [p.id, p]));
  const sources: ExportSource[] = [];
  for (const chat of chats) {
    const project = chat.project_id == null ? undefined : projects.get(chat.project_id);
    sources.push({
      chat,
      project: project && { name: project.name, path: project.path },
      messages: await loadMessages(chat.id),
    });
  }
  const bundle = buildBundle(sources, { includeImages });
  const content = format === "json" ? toJson(bundle) : toMarkdown(bundle, labels);
  const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  await fsx.write(path.slice(0, split) || "/", path.slice(split + 1), content);
  return path;
}

/** Fire-and-forget export for menus: failures are reported in a native dialog. */
export async function runChatExport(chats: Chat[], format: ExportFormat, t: T) {
  try {
    await exportChatsToFile(chats, format, { labels: mdLabels(t) });
  } catch (e) {
    await message(t("exportFailed", { error: errorText(e) }), { kind: "error" }).catch(() => {});
  }
}

const allChats = async () => [...(await listChats()), ...(await listArchived())];

/** SQLite-backed store for `importBundle`, built from the helpers in lib/data.ts. */
const dataStore: ChatStore = {
  existing: allChats,
  // Projects are matched by path, then by name. A path from a file is never registered as a new project, so an
  // import cannot hand the agent access to a directory the user did not add themselves.
  project: matchOrCreateProject,
  createChat,
  addMessage,
  async stamp(chatId, chat, messages) {
    for (const m of messages)
      if (m.createdAt) await db.exec("update messages set created_at = ? where id = ?", [m.createdAt, m.id]);
    const created = chat.createdAt ?? chat.updatedAt;
    if (created)
      await db.exec("update chats set created_at = ?, updated_at = ? where id = ?", [
        created,
        chat.updatedAt ?? created,
        chatId,
      ]);
    if (chat.archived) await archiveChat(chatId);
  },
  async discard(chatId) {
    await db.exec("delete from chats where id = ?", [chatId]);
  },
};

export const MAX_IMPORT_MB = 200;

/** Reads an Gustaf JSON export and adds its chats to the database; throws `ImportError` for unusable files. */
export async function importChatsFromFile(file: File, onProgress?: (done: number, total: number) => void) {
  if (file.size > MAX_IMPORT_MB * 1024 * 1024) throw new ImportError("too_large");
  return importBundle(parseBundle(await file.text()), dataStore, onProgress);
}

/** Export of all chats and import of an Gustaf JSON export. */
export function ChatTransfer() {
  const t = useT();
  const app = useApp();
  const [count, setCount] = useState(0);
  const [list, setList] = useState<Chat[]>([]);
  const [shareId, setShareId] = useState("");
  const [sharing, setSharing] = useState<Chat | null>(null);
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | "import" | null>(null);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);

  const refresh = () =>
    allChats().then(
      (c) => (setCount(c.length), setList(c)),
      () => {},
    );
  useEffect(() => void refresh(), []);

  const run = async (kind: ExportFormat | "import", job: () => Promise<string>) => {
    if (busy) return;
    setBusy(kind);
    setStatus("");
    setError("");
    try {
      setStatus(await job());
    } catch (e) {
      setError(
        e instanceof ImportError
          ? t(`importErr_${e.code}`, { mb: MAX_IMPORT_MB })
          : kind === "import"
            ? errorText(e)
            : t("exportFailed", { error: errorText(e) }),
      );
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };
  const exportAll = (format: ExportFormat) =>
    run(format, async () => {
      const path = await exportChatsToFile(await allChats(), format, { includeImages: images, labels: mdLabels(t) });
      return path ? t("exportSaved", { path }) : "";
    });
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    void run("import", async () => {
      const r = await importChatsFromFile(f, (done, total) => setProgress([done, total]));
      await app.reload();
      await refresh();
      return t("importChatsResult", { imported: r.imported, skipped: r.skipped });
    });
  };

  return (
    <>
      <h4 aria-level={2}>{t("chatFiles")}</h4>
      <p className="h4-sub">{t("chatFilesSub")}</p>
      <div className="card">
        {count > 0 && (
          <>
            <div className="card-row">
              <FileDown size={15} />
              <div className="grow">
                <div className="t">{t("exportAllChats")}</div>
                <div className="d">
                  {t("chatsCount", { count })} · {t("exportAllChatsSub")}
                </div>
              </div>
              {(["markdown", "json"] as const).map((f) => (
                <button key={f} className="btn-soft" disabled={!!busy} onClick={() => exportAll(f)}>
                  {busy === f && <Loader2 size={13} className="spin" />} {f === "json" ? "JSON" : "Markdown"}
                </button>
              ))}
            </div>
            <div className="card-row">
              <FileDown size={15} />
              <div className="grow">
                <div className="t">{t("shareHtmlTitle")}</div>
                <div className="d">{t("shareHtmlIntro")}</div>
              </div>
              <select
                className="input"
                aria-label={t("shareHtmlChat")}
                style={{ maxWidth: 180 }}
                value={shareId}
                onChange={(e) => setShareId(e.target.value)}
              >
                <option value="">{t("shareHtmlChat")}</option>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
              <button
                className="btn-soft"
                disabled={!shareId}
                onClick={() => setSharing(list.find((c) => String(c.id) === shareId) ?? null)}
              >
                {t("shareHtml")}
              </button>
            </div>
            <label className="card-row">
              <input type="checkbox" className="check" checked={images} onChange={(e) => setImages(e.target.checked)} />
              <div className="grow">
                <div className="t">{t("exportImages")}</div>
                <div className="d">{t("exportImagesSub")}</div>
              </div>
            </label>
          </>
        )}
        <div className="card-row">
          <FileUp size={15} />
          <div className="grow">
            <div className="t">{t("importChatsFile")}</div>
            <div className="d">{t("importChatsFileSub")}</div>
          </div>
          <button className="btn-soft" disabled={!!busy} onClick={() => file.current?.click()}>
            {busy === "import" && <Loader2 size={13} className="spin" />} {t("import")}
          </button>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={pick} />
        </div>
      </div>
      {busy === "import" && progress && (
        <div className="d" style={{ color: "var(--text-2)", marginTop: 8 }}>
          {t("importing", { done: progress[0], total: progress[1] })}
        </div>
      )}
      {status && (
        <div className="ok" role="status" style={{ fontSize: 12.5, marginTop: 8, wordBreak: "break-all" }}>
          {status}
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {sharing && <ShareHtmlDialog chat={sharing} onClose={() => setSharing(null)} />}
    </>
  );
}

/** One import element for every source (Cursor projects, Claude Code, Codex, ChatGPT) and the chat files; the Settings import page and onboarding both render this. */
export function ImportPanel({
  onDone,
  files = true,
}: {
  onDone: (imported: number) => void;
  /** Chat export/import files; left out of onboarding, where they only add noise. */ files?: boolean;
}) {
  const t = useT();
  const [source, setSource] = useState<"cursor" | ImportSource>("cursor");
  const [busy, setBusy] = useState(false);
  const tabs: { id: "cursor" | ImportSource; label: string }[] = [
    { id: "cursor", label: "Cursor" },
    ...SOURCES.map((s) => ({ id: s.id, label: s.label })),
  ];
  return (
    <>
      <div className="seg" role="group" aria-label={t("importFrom")}>
        {tabs.map((s) => (
          <button
            key={s.id}
            aria-pressed={source === s.id}
            className={source === s.id ? "active" : ""}
            disabled={busy}
            onClick={() => setSource(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="h4-sub" style={{ margin: "10px 0 12px" }}>
        {source === "cursor" ? t("importCursorSub") : t("historyImportSub")}
      </p>
      {source === "cursor" ? (
        <CursorImport onDone={onDone} onBusy={setBusy} />
      ) : (
        <HistoryImport source={source} onDone={onDone} onBusy={setBusy} />
      )}
      {files && <ChatTransfer />}
    </>
  );
}

/** Lists Cursor projects found on disk with checkboxes; imports the selected ones. */
function CursorImport({ onDone, onBusy }: { onDone: (imported: number) => void; onBusy?: (busy: boolean) => void }) {
  const t = useT();
  const [scan, setScan] = useState<{ projects: ImportProject[]; mcpServers: string[] } | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<[number, number] | null>(null);
  useEffect(() => {
    onBusy?.(!!progress);
  }, [progress, onBusy]);

  useEffect(() => {
    scanCursor()
      .then((s) => {
        setScan(s);
        setPicked(new Set(s.projects.slice(0, 5).map((p) => p.path)));
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  const toggle = (p: string) => {
    const n = new Set(picked);
    n.has(p) ? n.delete(p) : n.add(p);
    setPicked(n);
  };

  const run = async () => {
    setProgress([0, 1]);
    try {
      onDone(await importFromCursor([...picked], (d, n) => setProgress([d, n])));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setProgress(null);
    }
  };

  if (error) return <div className="error-box">{error}</div>;
  if (!scan)
    return (
      <div className="card">
        <div className="card-row">
          <Loader2 size={15} className="spin" /> {t("scanningCursor")}
        </div>
      </div>
    );

  return (
    <div>
      <div className="card" style={{ maxHeight: 340, overflowY: "auto" }}>
        {!scan.projects.length && <div className="card-row d">{t("cursorNothing")}</div>}
        {scan.projects.map((p) => (
          <label key={p.path} className="card-row">
            <input type="checkbox" className="check" checked={picked.has(p.path)} onChange={() => toggle(p.path)} />
            <MousePointer2 size={15} />
            <div className="grow">
              <div className="t">{p.name}</div>
              <div className="d" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.path}
              </div>
            </div>
            <span className="d">{t("chatsCount", { count: p.chats })}</span>
          </label>
        ))}
      </div>
      {scan.mcpServers.length > 0 && (
        <>
          <h4 aria-level={2}>{t("mcpFound")}</h4>
          <div className="card">
            <div className="card-row">
              <Plug size={15} />
              <div className="grow d">{scan.mcpServers.join(", ")}</div>
              <span className="d ok">{t("mcpShared")}</span>
            </div>
          </div>
        </>
      )}
      <div className="onb-foot">
        <span className="d" style={{ color: "var(--text-2)" }}>
          {progress
            ? t("importing", { done: progress[0], total: progress[1] })
            : t("selectedProjects", { count: picked.size })}
        </span>
        <button className="btn btn-primary" disabled={!picked.size || !!progress} onClick={run}>
          {progress && <Loader2 size={13} className="spin" />} {t("import")}
        </button>
      </div>
    </div>
  );
}
