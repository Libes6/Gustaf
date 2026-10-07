import { FolderOpen, Trash2 } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { InterruptedWork } from "../lib/interruptedWork";
import { refreshWorkspaces } from "../lib/workspaceStore";
import { parseWorktreeError, worktrees } from "../lib/worktrees";
import { ConfirmDialog } from "./WorkspaceDialogs";

const SHOWN_FILES = 4;

/** Names of the changed files (read-only `worktree_diff`); empty while loading or when it fails. */
function useFileNames(root: string, taskId: string, enabled: boolean): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    worktrees.diff(root, taskId).then((d) => { if (alive) setNames(d.files.map((f) => f.path)); }, () => {});
    return () => { alive = false; };
  }, [root, taskId, enabled]);
  return names;
}

function Entry({ root, w, onDiscard }: { root: string; w: InterruptedWork; onDiscard: () => void }) {
  const t = useT();
  const names = useFileNames(root, w.taskId, w.files > 0);
  const commits = w.commits === null ? t("interruptedCommitsSome") : t("interruptedCommits", { count: w.commits });
  return (
    <article className="agent-card" aria-label={w.branch}>
      <div className="agent-card-body">
        <div className="agent-card-title"><strong title={w.branch}>{w.branch}</strong></div>
        <div className="agent-card-meta">
          <span>{commits}</span>
          <span>{t("interruptedFiles", { count: w.files })}</span>
          {w.model && <span title={w.model}>{w.model}</span>}
        </div>
        {names.length > 0 && (
          <div className="agent-card-note" title={names.join("\n")}>
            {names.slice(0, SHOWN_FILES).join(", ")}{names.length > SHOWN_FILES ? `, +${names.length - SHOWN_FILES}` : ""}
          </div>
        )}
        <div className="agent-card-actions">
          <button className="btn-soft" onClick={() => void Promise.resolve(revealItemInDir(w.path)).catch(() => {})}><FolderOpen size={11} /> {t("interruptedOpen")}</button>
          <button className="btn-soft" onClick={onDiscard}><Trash2 size={11} /> {t("interruptedDiscard")}</button>
        </div>
      </div>
    </article>
  );
}

/**
 * Worktrees an agent left behind with uncommitted changes or unmerged commits (see lib/interruptedWork.ts). Listing is
 * read-only; Discard removes the checkout and its branch only after a confirmation that names the branch and what is lost.
 */
export function InterruptedWorkSection({ root, items }: { root: string; items: readonly InterruptedWork[] }) {
  const t = useT();
  const [asking, setAsking] = useState<InterruptedWork | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!items.length && !asking) return null;
  const discard = async () => {
    if (!asking) return;
    setBusy(true);
    setError("");
    try {
      await worktrees.remove({ root, taskId: asking.taskId, force: true, deleteBranch: true });
      void refreshWorkspaces(root, { force: true });
      setAsking(null);
    } catch (e) {
      setError(parseWorktreeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={t("interruptedTitle")}>
      <h3 className="agents-group">{t("interruptedTitle")}</h3>
      <div className="hint">{t("interruptedHint")}</div>
      {items.map((w) => <Entry key={w.taskId} root={root} w={w} onDiscard={() => { setError(""); setAsking(w); }} />)}
      {asking && (
        <ConfirmDialog
          title={t("interruptedDiscardTitle", { branch: asking.branch })}
          confirmLabel={t("interruptedDiscardConfirm")}
          danger
          busy={busy}
          onConfirm={() => void discard()}
          onCancel={() => { if (!busy) setAsking(null); }}
        >
          <p>{t("interruptedDiscardBody", { branch: asking.branch, files: asking.files, commits: asking.commits === null ? t("interruptedCommitsSome") : t("interruptedCommits", { count: asking.commits }) })}</p>
          {error && <div className="error-box" role="alert">{error}</div>}
        </ConfirmDialog>
      )}
    </section>
  );
}
