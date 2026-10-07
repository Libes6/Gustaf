import { open } from "@tauri-apps/plugin-dialog";
import { FilePlus, FolderPlus, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { secrets } from "../lib/api";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useApp } from "../state";
import { loadSemantic } from "../agent/semanticSearch";
import {
  DOC_INCLUDE,
  emitKnowledgeChange,
  formatBytes,
  includesCode,
  knowledge,
  onKnowledgeProgress,
  withCode,
  type EmbedConfig,
  type KnowledgeCollection,
  type KnowledgeEstimate,
  type KnowledgeProgress,
} from "../agent/knowledge";

const DEFAULTS: Record<EmbedConfig["kind"], EmbedConfig> = {
  ollama: { kind: "ollama", endpoint: "http://127.0.0.1:11434", model: "embeddinggemma" },
  openai: { kind: "openai", endpoint: "https://api.openai.com/v1", model: "text-embedding-3-small" },
};
const isLocal = (endpoint: string) => {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(endpoint).hostname);
  } catch {
    return false;
  }
};
const providerLabel = (c: EmbedConfig) => {
  const host = (() => {
    try {
      return new URL(c.endpoint).host;
    } catch {
      return c.endpoint;
    }
  })();
  return c.kind === "ollama" ? `Ollama (${host})` : `${host} (${c.model})`;
};

/** Settings → Knowledge: named collections of folders and files that chats can search (docs/features/knowledge-base.md). */
export function KnowledgeSettings() {
  const t = useT();
  const app = useApp();
  const [items, setItems] = useState<KnowledgeCollection[] | null>(null);
  const [progress, setProgress] = useState<Record<string, KnowledgeProgress>>({});
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<{ collection: KnowledgeCollection; estimate: KnowledgeEstimate } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [config, setConfig] = useState<EmbedConfig>(DEFAULTS.ollama);
  const [key, setKey] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [running, setRunning] = useState<Set<string>>(new Set());

  const refresh = async () => {
    try {
      setItems(await knowledge.list());
    } catch (e) {
      setError(String(e));
      setItems((v) => v ?? []);
    }
  };
  useEffect(() => {
    void refresh();
    let off = () => {};
    let alive = true;
    void onKnowledgeProgress((p) => {
      setProgress((m) => ({ ...m, [p.id]: p }));
      if (p.phase === "done" || p.phase === "cancelled" || p.phase === "error") void refresh();
    }).then((fn) => (alive ? (off = fn) : fn()));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const change = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    }
    await refresh();
    emitKnowledgeChange();
  };

  const index = async (c: KnowledgeCollection, confirmed: boolean) => {
    setRunning((s) => new Set(s).add(c.id));
    setProgress(({ [c.id]: _gone, ...rest }) => rest);
    await change(() => knowledge.reindex(c.id, confirmed));
    setRunning((s) => {
      const n = new Set(s);
      n.delete(c.id);
      return n;
    });
  };
  const startIndex = async (c: KnowledgeCollection) => {
    if (c.consentedAt !== null) return index(c, false);
    setError("");
    try {
      setConfirm({ collection: c, estimate: await knowledge.estimate(c.id) });
    } catch (e) {
      setError(String(e));
    }
  };

  const copyProvider = async (root: string) => {
    setCopyFrom(root);
    if (!root) return setConfig(DEFAULTS.ollama);
    const s = await loadSemantic(root).catch(() => null);
    if (s) setConfig({ kind: s.kind, endpoint: s.endpoint, model: s.model, keyId: s.keyId ?? null });
  };
  const create = () =>
    change(async () => {
      let next: EmbedConfig = { ...config, keyId: config.kind === "openai" ? (config.keyId ?? null) : null };
      if (config.kind === "openai" && key.trim()) {
        next = { ...next, keyId: `knowledge:${crypto.randomUUID()}` };
        await secrets.set(next.keyId!, key.trim());
      }
      await knowledge.create(name.trim(), next);
      setName("");
      setKey("");
    });
  const pick = (c: KnowledgeCollection, directory: boolean) =>
    change(async () => {
      const picked = await open({ directory, multiple: false });
      if (typeof picked === "string") await knowledge.addSource(c.id, picked);
    });

  const statusLabel = (c: KnowledgeCollection) =>
    c.indexing || running.has(c.id)
      ? t("knowledgeStatusIndexing")
      : t(
          c.status.state === "ready"
            ? "knowledgeStatusReady"
            : c.status.state === "stale"
              ? "knowledgeStatusStale"
              : c.status.state === "partial"
                ? "knowledgeStatusPartial"
                : "knowledgeStatusNew",
        );
  const projects = app.projects.filter((p) => p.path);

  return (
    <>
      <h1>{t("knowledgeNav")}</h1>
      <p className="lead">{t("knowledgeLead")}</p>
      <p className="d" role="note">
        {t("knowledgePrivacy")}
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        {items?.length === 0 && <div className="card-row d">{t("knowledgeEmpty")}</div>}
        {items?.map((c) => {
          const busy = c.indexing || running.has(c.id);
          const p = progress[c.id];
          return (
            <section key={c.id} className="card-row" aria-label={c.name} style={{ display: "block" }}>
              <div className="card-row" style={{ padding: 0 }}>
                {renaming?.id === c.id ? (
                  <form
                    className="grow"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const r = renaming;
                      setRenaming(null);
                      void change(() => knowledge.rename(r.id, r.name));
                    }}
                  >
                    <input
                      className="input"
                      aria-label={t("knowledgeRename")}
                      autoFocus
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                      onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                    />
                  </form>
                ) : (
                  <div className="grow">
                    <div className="t">{c.name}</div>
                    <div className="d">
                      <span role="status">{statusLabel(c)}</span>
                      {c.status.chunks > 0 &&
                        ` · ${t("knowledgeStats", { files: c.status.files, chunks: c.status.chunks, provider: providerLabel(c.config) })}`}
                      {c.status.chunks === 0 && ` · ${providerLabel(c.config)}`}
                    </div>
                  </div>
                )}
                <button className="btn-soft" disabled={busy} onClick={() => setRenaming({ id: c.id, name: c.name })}>
                  {t("knowledgeRename")}
                </button>
                {busy ? (
                  <button className="btn-soft" onClick={() => void knowledge.cancel(c.id)}>
                    {t("knowledgeStop")}
                  </button>
                ) : (
                  <button className="btn btn-primary" disabled={!c.sources.length} onClick={() => void startIndex(c)}>
                    {c.status.indexedAt ? t("knowledgeReindex") : t("knowledgeIndex")}
                  </button>
                )}
              </div>
              {busy && p && p.phase === "embed" && (
                <progress
                  max={Math.max(1, p.total)}
                  value={p.done}
                  aria-label={t("knowledgeProgress", { done: p.done, total: p.total })}
                />
              )}
              {busy && p && (
                <div className="d">
                  {p.phase === "embed" ? t("knowledgeProgress", { done: p.done, total: p.total }) : (p.file ?? "")}
                </div>
              )}
              {c.status.lastError && (
                <div className="error-box" role="alert">
                  {c.status.lastError}
                </div>
              )}
              {c.status.warnings.map((w) => (
                <div className="d" key={w}>
                  {w}
                </div>
              ))}
              {c.status.issues.length > 0 && (
                <details>
                  <summary className="d">{t("knowledgeIssues", { count: c.status.issues.length })}</summary>
                  <ul className="d">
                    {c.status.issues.map((i, n) => (
                      <li key={n}>
                        <code>{i.path}</code>: {i.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="d" style={{ marginTop: 8 }}>
                {t("knowledgeSources")}
              </div>
              {!c.sources.length && <div className="d">{t("knowledgeNoSources")}</div>}
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
                {c.sources.map((s) => (
                  <li key={s.path} className="card-row" style={{ padding: "2px 0" }}>
                    <code className="grow">{s.path}</code>
                    <button
                      className="icon-btn"
                      disabled={busy}
                      title={t("knowledgeRemoveSource", { path: s.path })}
                      aria-label={t("knowledgeRemoveSource", { path: s.path })}
                      onClick={() => void change(() => knowledge.removeSource(c.id, s.path))}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="card-row" style={{ padding: "8px 0 0" }}>
                <button className="btn-soft" disabled={busy} onClick={() => void pick(c, true)}>
                  <FolderPlus size={13} /> {t("knowledgeAddFolder")}
                </button>
                <button className="btn-soft" disabled={busy} onClick={() => void pick(c, false)}>
                  <FilePlus size={13} /> {t("knowledgeAddFile")}
                </button>
                <label
                  className="grow"
                  style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end" }}
                >
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={includesCode(c.include)}
                    onChange={(e) =>
                      void change(() =>
                        knowledge.setInclude(
                          c.id,
                          withCode(c.include.length ? c.include : DOC_INCLUDE, e.target.checked),
                        ),
                      )
                    }
                  />
                  {t("knowledgeIncludeCode")}
                </label>
                {deleting === c.id ? (
                  <>
                    <span className="d">{t("knowledgeDeleteAsk", { name: c.name })}</span>
                    <button
                      className="btn btn-danger"
                      onClick={() => {
                        setDeleting(null);
                        void change(() => knowledge.remove(c.id));
                      }}
                    >
                      {t("knowledgeDelete")}
                    </button>
                    <button className="btn btn-ghost" onClick={() => setDeleting(null)}>
                      {t("cancel")}
                    </button>
                  </>
                ) : (
                  <button className="btn-soft" onClick={() => setDeleting(c.id)}>
                    <Trash2 size={13} /> {t("knowledgeDelete")}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>

      <h4>{t("knowledgeCreate")}</h4>
      <label htmlFor="kb-name">{t("knowledgeNewName")}</label>
      <input id="kb-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      {projects.length > 0 && (
        <>
          <label htmlFor="kb-copy">{t("knowledgeProviderFrom")}</label>
          <select id="kb-copy" className="input" value={copyFrom} onChange={(e) => void copyProvider(e.target.value)}>
            <option value="">{t("knowledgeProviderDefaults")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.path!}>
                {p.name}
              </option>
            ))}
          </select>
        </>
      )}
      <label htmlFor="kb-kind">{t("knowledgeProviderKind")}</label>
      <select
        id="kb-kind"
        className="input"
        value={config.kind}
        onChange={(e) => {
          setCopyFrom("");
          setConfig(DEFAULTS[e.target.value as EmbedConfig["kind"]]);
        }}
      >
        <option value="ollama">Ollama (local)</option>
        <option value="openai">OpenAI-compatible</option>
      </select>
      <label htmlFor="kb-endpoint">{t("knowledgeEndpoint")}</label>
      <input
        id="kb-endpoint"
        className="input"
        value={config.endpoint}
        onChange={(e) => setConfig({ ...config, endpoint: e.target.value })}
      />
      <label htmlFor="kb-model">{t("knowledgeModel")}</label>
      <input
        id="kb-model"
        className="input"
        value={config.model}
        onChange={(e) => setConfig({ ...config, model: e.target.value })}
      />
      {config.kind === "openai" && (
        <>
          <label htmlFor="kb-key">
            {t("knowledgeApiKey")}
            {config.keyId ? " ✓" : ""}
          </label>
          <input
            id="kb-key"
            className="input"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </>
      )}
      <div className="card-row">
        <button
          className="btn btn-primary"
          disabled={!name.trim() || !config.model.trim() || !config.endpoint.trim()}
          onClick={() => void create()}
        >
          {t("knowledgeCreate")}
        </button>
      </div>

      {confirm && (
        <ConfirmIndex
          collection={confirm.collection}
          estimate={confirm.estimate}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm.collection;
            setConfirm(null);
            void index(c, true);
          }}
        />
      )}
    </>
  );
}

/** Explicit consent before a collection's first index: names the provider and says how much text is sent. */
function ConfirmIndex({
  collection,
  estimate,
  onCancel,
  onConfirm,
}: {
  collection: KnowledgeCollection;
  estimate: KnowledgeEstimate;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onCancel);
  const local = isLocal(collection.config.endpoint);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={ref}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={t("knowledgeConfirmTitle", { name: collection.name })}
      >
        <h2>
          <span className="grow">{t("knowledgeConfirmTitle", { name: collection.name })}</span>
        </h2>
        <p>
          {t("knowledgeConfirmBody", {
            files: estimate.files,
            size: formatBytes(estimate.bytes),
            provider: providerLabel(collection.config),
          })}
        </p>
        <p className="d">{local ? t("knowledgeConfirmLocal") : t("knowledgeConfirmRemote")}</p>
        {estimate.warnings.map((w) => (
          <p className="d" key={w}>
            {w}
          </p>
        ))}
        <div className="dialog-foot">
          <button className="btn btn-ghost" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button className="btn btn-primary" data-autofocus onClick={onConfirm}>
            {t("knowledgeConfirmGo")}
          </button>
        </div>
      </div>
    </div>
  );
}
