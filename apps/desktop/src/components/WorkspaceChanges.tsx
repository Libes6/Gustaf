import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { fsx, git } from "../lib/api";
import { stripLineNumbers } from "../lib/autoReview";
import { worktrees, type WorktreeDiff } from "../lib/worktrees";
import { relativeToProject, untrackedDiffText } from "../lib/workspaceDiff";
import "../styles/workspaces.css";

/**
 * The net change of a workspace against the commit it was created from (committed and uncommitted work together, as
 * `worktrees.diff` reports it). The edits are already on disk in the workspace's checkout, so there is nothing to accept
 * here: a click shows the file's diff with the panel's usual diff view. Commit, push and pull request use the checkout
 * and its branch (the panel's commit button and `GitPublishPanel`).
 */
export function WorkspaceChanges({ projectRoot, taskId, branch, root, prefix, tick, onShowDiff, onError }: {
  projectRoot: string; taskId: string; branch: string;
  /** The folder the chat works in (the checkout, at the project's subfolder). */
  root: string;
  /** Where the project sits in its repository (`""` or `sub/dir/`). */
  prefix: string;
  tick: number;
  onShowDiff: (path: string, text: string) => void;
  onError: (message: string) => void;
}) {
  const t = useT();
  const [diff, setDiff] = useState<WorktreeDiff | null>(null);
  useEffect(() => {
    let cancelled = false;
    worktrees.diff(projectRoot, taskId).then((d) => { if (!cancelled) setDiff(d); }, (e) => { if (!cancelled) onError(String((e as Error)?.message ?? e)); });
    return () => { cancelled = true; };
  }, [projectRoot, taskId, tick]);

  const open = async (path: string, status: string) => {
    try {
      if (status === "untracked") {
        const rel = relativeToProject(path, prefix);
        onShowDiff(path, rel === null ? "" : untrackedDiffText(stripLineNumbers(await fsx.read(root, rel))));
      } else {
        // `:(top)` makes the path relative to the repository, as the list reports it, whatever folder `root` is.
        onShowDiff(path, await git(root, ["diff", "--no-color", "--no-ext-diff", diff!.base, "--", `:(top)${path}`]));
      }
    } catch (e) { onError(String((e as Error)?.message ?? e)); }
  };

  return (
    <div className="ws-diff">
      <div className="review-intro"><strong>{t("workspaceDiffTitle")}</strong><p>{t("workspaceDiffHint", { branch })}</p></div>
      {diff && !diff.files.length && <div className="hint" style={{ padding: "0 12px 12px" }}>{t("workspaceDiffEmpty")}</div>}
      {diff?.files.map((f) => (
        <div key={f.path} className="file-row">
          <button className="path" disabled={f.binary} onClick={() => void open(f.path, f.status)}>{f.path}</button>
          <span className={`status ${f.status}`}>{f.binary ? t("workspaceDiffBinary") : t(`workspaceStatus_${f.status}`)}</span>
          {!f.binary && <span className="plus">+{f.additions}</span>}
          {!f.binary && <span className="minus">−{f.deletions}</span>}
        </div>
      ))}
      {diff?.truncated && <div className="hint" style={{ padding: "0 12px 12px" }}>{t("workspaceDiffTruncated")}</div>}
    </div>
  );
}
