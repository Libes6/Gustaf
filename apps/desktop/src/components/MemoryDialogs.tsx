import { Loader2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { MEMORY_CAP } from "../agent/memory";
import type { Suggestion, SuggestScope } from "../agent/memorySuggest";
import type { Chat, Project } from "../lib/data";
import { storeSuggestions, suggestMemories, SuggestParseError } from "../lib/memorySuggestRun";
import { useDialogFocus } from "../lib/useDialogFocus";
import { useApp } from "../state";
import { MemoryEditor } from "./MemorySettings";
import "../styles/gitCommit.css";
import "../styles/memory.css";

function Shell({
  title,
  label,
  busy,
  onClose,
  children,
  footer,
}: {
  title: string;
  label: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, () => {
    if (!busy) onClose();
  });
  return createPortal(
    <div
      className="review-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section ref={ref} className="review-dialog git-dialog" role="dialog" aria-modal="true" aria-label={label}>
        <header>
          <strong>{title}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose} disabled={busy}>
            <X size={17} />
          </button>
        </header>
        {children}
        {footer && <div className="review-actions git-actions">{footer}</div>}
      </section>
    </div>,
    document.body,
  );
}

/** The project menu's "Memory…": this project's facts plus the global ones, with the same editor as Settings -> Memory. */
export function MemoryProjectDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const t = useT();
  return (
    <Shell
      title={`${t("memoryTitle")} · ${project.name}`}
      label={t("memoryTitle")}
      onClose={onClose}
      footer={
        <>
          <span className="git-note muted grow">{t("memoryProjectHint")}</span>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("memoryClose")}
          </button>
        </>
      }
    >
      <div className="git-body memory-body">
        <MemoryEditor root={project.path} name={project.name} includeGlobal />
      </div>
    </Shell>
  );
}

type Row = Suggestion & { checked: boolean };
type Phase = "idle" | "running" | "review" | "error";

/**
 * "Suggest memories from this chat". One request to the cheap model (lib/memorySuggestRun.ts); the facts it proposes are only
 * a list to look at: each has a checkbox, a scope and editable text, and only the ticked ones are stored, after the confirm button.
 * With `initial` (the opt-in end-of-chat run already made the request) the dialog opens on the result.
 */
export function MemorySuggestDialog({
  chat,
  project,
  initial,
  onClose,
}: {
  chat: Pick<Chat, "id" | "title">;
  project: Project | null;
  initial?: Suggestion[];
  onClose: () => void;
}) {
  const t = useT();
  const app = useApp();
  const root = project?.path ?? null;
  const [phase, setPhase] = useState<Phase>(initial ? "review" : "idle");
  const [rows, setRows] = useState<Row[]>(() => (initial ?? []).map((s) => ({ ...s, checked: true })));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ saved: number; skipped: number } | null>(null);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);

  const start = async () => {
    const c = new AbortController();
    ctl.current = c;
    setPhase("running");
    setError("");
    try {
      const r = await suggestMemories(app, { chatId: chat.id, projectRoot: root, signal: c.signal });
      if (c.signal.aborted) return;
      setRows(r.suggestions.map((s) => ({ ...s, checked: true })));
      setPhase("review");
    } catch (e) {
      if (c.signal.aborted) return;
      setError(
        e instanceof SuggestParseError ? t("memorySuggestUnparsable") : String(e instanceof Error ? e.message : e),
      );
      setPhase("error");
    }
  };
  const cancel = () => {
    ctl.current?.abort();
    setPhase("idle");
  };
  const patch = (id: string, p: Partial<Row>) => setRows((all) => all.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const chosen = rows.filter((r) => r.checked);
  const save = async () => {
    if (saving || !chosen.length || chosen.some((r) => !r.text.trim())) return;
    setSaving(true);
    setError("");
    try {
      setResult(
        await storeSuggestions(
          chosen.map((r) => ({ text: r.text.trim(), scope: r.scope })),
          { projectRoot: root, chatId: chat.id },
        ),
      );
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Shell
      title={`${t("memorySuggestTitle")} · ${chat.title}`}
      label={t("memorySuggestTitle")}
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <span className="git-note muted grow" />
          <button className="btn btn-ghost" onClick={phase === "running" ? cancel : onClose} disabled={saving}>
            {result ? t("memoryClose") : t("cancel")}
          </button>
          {(phase === "idle" || phase === "error") && (
            <button className="btn btn-primary" onClick={start}>
              {phase === "error" ? t("retryRequest") : t("memorySuggestRun")}
            </button>
          )}
          {phase === "review" && !result && (
            <button
              className="btn btn-primary"
              disabled={saving || !chosen.length || chosen.some((r) => !r.text.trim())}
              onClick={save}
            >
              {saving && <Loader2 size={13} className="spin" />} {t("memorySuggestSave", { count: chosen.length })}
            </button>
          )}
        </>
      }
    >
      <div className="git-body memory-body">
        <div className="git-note muted">{t("memorySuggestCost")}</div>
        {phase === "running" && (
          <div className="git-state" role="status">
            <Loader2 size={14} className="spin" /> {t("memorySuggestRunning")}
          </div>
        )}
        {phase === "review" && !rows.length && (
          <div className="git-note muted" role="status">
            {t("memorySuggestNone")}
          </div>
        )}
        {phase === "review" && rows.length > 0 && (
          <div className="memory-suggestions" role="group" aria-label={t("memorySuggestList")}>
            {rows.map((r, i) => (
              <div className="memory-suggestion" key={r.id}>
                <input
                  type="checkbox"
                  className="check"
                  checked={r.checked}
                  disabled={saving || !!result}
                  aria-label={t("memorySuggestKeep", { n: i + 1 })}
                  onChange={(e) => patch(r.id, { checked: e.target.checked })}
                />
                <textarea
                  className="input"
                  rows={2}
                  value={r.text}
                  maxLength={MEMORY_CAP}
                  disabled={saving || !!result}
                  aria-label={t("memorySuggestText", { n: i + 1 })}
                  onChange={(e) => patch(r.id, { text: e.target.value })}
                />
                <select
                  className="input git-select"
                  value={r.scope}
                  disabled={saving || !!result || !root}
                  aria-label={t("memorySuggestScope", { n: i + 1 })}
                  onChange={(e) => patch(r.id, { scope: e.target.value as SuggestScope })}
                >
                  {root && <option value="project">{t("memoryScopeProject")}</option>}
                  <option value="global">{t("memoryGlobal")}</option>
                </select>
              </div>
            ))}
          </div>
        )}
        {result && (
          <div className="ok git-note" role="status">
            {t("memorySuggestSaved", { saved: result.saved, skipped: result.skipped })}
          </div>
        )}
      </div>
      {error && (
        <div className="error-box git-error git-error-foot" role="alert">
          {error}
        </div>
      )}
    </Shell>
  );
}

/** For the sidebar: two openers and one node to mount, so the sidebar itself only gains a menu item each. */
export function useMemoryDialogs() {
  const app = useApp();
  const [project, setProject] = useState<Project | null>(null);
  const [suggest, setSuggest] = useState<Chat | null>(null);
  const node = (
    <>
      {project?.path && <MemoryProjectDialog project={project} onClose={() => setProject(null)} />}
      {suggest && (
        <MemorySuggestDialog
          chat={suggest}
          project={app.projects.find((p) => p.id === suggest.project_id) ?? null}
          onClose={() => setSuggest(null)}
        />
      )}
    </>
  );
  return { openProject: setProject, openSuggest: setSuggest, node };
}
