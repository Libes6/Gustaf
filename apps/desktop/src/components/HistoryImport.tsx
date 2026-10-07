import { open } from "@tauri-apps/plugin-dialog";
import { FileJson, Loader2, MessagesSquare, Search, Terminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { importSources, type SourceSession } from "../lib/api";
import type { ImportedChat, ImportSource } from "../lib/importers/common";
import { parseChatGptConversation } from "../lib/importers/chatgpt";
import { parseClaudeSession } from "../lib/importers/claudeCode";
import { parseCodexSession } from "../lib/importers/codex";
import { LIST_LIMIT, filterSessions, selectable } from "../lib/importers/list";
import { duplicateKeys, importChats } from "../lib/importers/run";
import { importStore, recordImport } from "../lib/importers/store";

const errorText = (e: unknown) => String(e instanceof Error ? e.message : e);
export const SOURCES: { id: ImportSource; label: string; icon: typeof Terminal }[] = [
  { id: "claude-code", label: "Claude Code", icon: Terminal },
  { id: "codex", label: "Codex", icon: Terminal },
  { id: "chatgpt", label: "ChatGPT", icon: MessagesSquare },
];
/** ChatGPT conversations are fetched from the export file this many at a time (each fetch streams through the file once). */
const CHATGPT_BATCH = 20;

/** Lists sessions of Claude Code and Codex, or conversations of a ChatGPT export, and imports the ticked ones. The source tab is chosen by ImportPanel. */
export function HistoryImport({
  source,
  onDone,
  onBusy,
}: {
  source: ImportSource;
  onDone: (imported: number) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const t = useT();
  const [sessions, setSessions] = useState<SourceSession[] | null>(null);
  const [exportPath, setExportPath] = useState("");
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<[number, number] | null>(null);
  // Only the newest scan may update the list when the user switches sources quickly.
  const scanId = useRef(0);

  const scan = useCallback(async (src: ImportSource, path: string) => {
    const mine = ++scanId.current;
    setSessions(null);
    setPicked(new Set());
    setError("");
    setStatus("");
    setLoading(true);
    try {
      const list =
        src === "chatgpt"
          ? path
            ? await importSources.chatgptScan(path)
            : []
          : await importSources.scan(src === "codex" ? "codex" : "claude");
      const keys = duplicateKeys(await importStore.existing());
      if (mine !== scanId.current) return;
      setKnown(new Set(list.filter((s) => keys.ids.has(`${src}:${s.id}`)).map((s) => s.id)));
      setSessions(list);
    } catch (e) {
      if (mine === scanId.current) setError(errorText(e));
    } finally {
      if (mine === scanId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setQuery("");
    setExportPath("");
    if (source !== "chatgpt") void scan(source, "");
    else {
      scanId.current++;
      setSessions(null);
      setPicked(new Set());
      setError("");
      setStatus("");
      setLoading(false);
    }
  }, [source, scan]);

  const chooseFile = async () => {
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof path !== "string") return;
      setExportPath(path);
      await scan("chatgpt", path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const shown = useMemo(() => filterSessions(sessions ?? [], query), [sessions, query]);
  const visible = shown.slice(0, LIST_LIMIT);
  const toggle = (id: string) => {
    const n = new Set(picked);
    n.has(id) ? n.delete(id) : n.add(id);
    setPicked(n);
  };

  const run = async () => {
    const items = (sessions ?? []).filter((s) => picked.has(s.id));
    if (!items.length || progress) return;
    setError("");
    setStatus("");
    setProgress([0, items.length]);
    const cache = new Map<string, ImportedChat | null>();
    const load = async (i: number): Promise<ImportedChat | null> => {
      const s = items[i];
      if (source !== "chatgpt") {
        const { text } = await importSources.readSession(source === "codex" ? "codex" : "claude", s.path);
        return source === "codex" ? parseCodexSession(text, s.id) : parseClaudeSession(text, s.id);
      }
      if (!cache.has(s.id)) {
        // Fetch this conversation together with the next ones that still need importing.
        const ids = items
          .slice(i, i + CHATGPT_BATCH)
          .map((x) => x.id)
          .filter((id) => !known.has(id));
        const batch = await importSources.chatgptRead(exportPath, ids);
        for (const id of ids) cache.set(id, null);
        for (const raw of batch.conversations) {
          const chat = parseChatGptConversation(raw);
          if (chat) cache.set(chat.sourceId, chat);
        }
      }
      const chat = cache.get(s.id) ?? null;
      cache.delete(s.id);
      return chat;
    };
    try {
      const r = await importChats(
        items.map((s) => ({ source, sourceId: s.id })),
        load,
        importStore,
        (d, n) => setProgress([d, n]),
      );
      if (r.imported) await recordImport(source, r.imported);
      setStatus(
        t("importChatsResult", { imported: r.imported, skipped: r.skipped }) +
          (r.failed ? ` ${t("historyFailed", { count: r.failed })}` : ""),
      );
      await scan(source, exportPath);
      if (r.imported) onDone(r.imported);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  };

  useEffect(() => {
    onBusy?.(!!progress);
  }, [progress, onBusy]);
  const Icon = SOURCES.find((s) => s.id === source)!.icon;
  const selectableShown = selectable(shown, known);
  return (
    <div>
      {source === "chatgpt" && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-row">
            <FileJson size={15} />
            <div className="grow">
              <div className="t">{exportPath ? exportPath.split(/[\\/]/).pop() : t("historyPickFile")}</div>
              <div
                className="d"
                style={exportPath ? { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}
              >
                {exportPath || t("historyPickFileSub")}
              </div>
            </div>
            <button className="btn-soft" disabled={loading || !!progress} onClick={chooseFile}>
              {exportPath ? t("historyPickAnother") : t("historyChoose")}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="card">
          <div className="card-row">
            <Loader2 size={15} className="spin" /> {t("historyScanning")}
          </div>
        </div>
      )}
      {sessions && (
        <>
          <div className="input-group" style={{ marginBottom: 8 }}>
            <span className="icon">
              <Search size={14} />
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("historySearch")}
              aria-label={t("historySearch")}
            />
          </div>
          <div className="card" style={{ maxHeight: 340, overflowY: "auto" }}>
            {!sessions.length && <div className="card-row d">{t("historyNothing")}</div>}
            {!!sessions.length && !shown.length && <div className="card-row d">{t("historyNoMatch")}</div>}
            {visible.map((s) => {
              const done = known.has(s.id);
              return (
                <label key={s.id} className="card-row" style={done ? { opacity: 0.6 } : undefined}>
                  <input
                    type="checkbox"
                    className="check"
                    disabled={done || !!progress}
                    checked={picked.has(s.id)}
                    onChange={() => toggle(s.id)}
                  />
                  <Icon size={15} />
                  <div className="grow">
                    <div className="t" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.title || t("historyUntitled")}
                    </div>
                    <div className="d" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {[s.projectPath, s.updatedAt ? t.date(s.updatedAt) : ""].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <span className="d">
                    {done ? t("historyImported") : t("historyMessages", { count: s.messageCount })}
                  </span>
                </label>
              );
            })}
            {shown.length > visible.length && (
              <div className="card-row d">{t("historyMore", { count: shown.length - visible.length })}</div>
            )}
          </div>
          <div className="onb-foot">
            <span className="d" style={{ color: "var(--text-2)" }}>
              {progress
                ? t("importing", { done: progress[0], total: progress[1] })
                : t("historySelected", { count: picked.size })}
              {!progress && !!selectableShown.length && (
                <button
                  className="btn-soft"
                  style={{ marginLeft: 10 }}
                  onClick={() => setPicked(new Set([...picked, ...selectableShown.map((s) => s.id)]))}
                >
                  {t("historySelectShown")}
                </button>
              )}
              {!progress && !!picked.size && (
                <button className="btn-soft" style={{ marginLeft: 6 }} onClick={() => setPicked(new Set())}>
                  {t("historyClear")}
                </button>
              )}
            </span>
            <button className="btn btn-primary" disabled={!picked.size || !!progress} onClick={run}>
              {progress && <Loader2 size={13} className="spin" />} {t("import")}
            </button>
          </div>
        </>
      )}
      {status && (
        <div className="ok" role="status" style={{ fontSize: 12.5, marginTop: 8 }}>
          {status}
        </div>
      )}
    </div>
  );
}
