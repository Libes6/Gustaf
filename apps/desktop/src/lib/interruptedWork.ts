// Pure scan result for "interrupted agent work": git worktrees of a project that no chat owns anymore (a subagent's
// checkout, a workspace whose chat is gone) and that still hold uncommitted changes or commits not merged into their
// base. The data comes from the read-only `worktree_list` command (git worktree list / status / rev-list); nothing here
// touches git. Node runs this file in tests/interruptedWork.test.mjs, so only `import type` is allowed.
import type { WorktreeInfo } from "./worktrees";

export type InterruptedWork = {
  taskId: string;
  branch: string;
  path: string;
  /** Commits ahead of the base branch; null when they exist but cannot be counted (the base was a raw commit). */
  commits: number | null;
  /** Uncommitted files (`git status --porcelain` lines). */
  files: number;
  provider: string | null;
  model: string | null;
  createdAt: number;
};

/** Unmerged commits: ahead of the base branch, or (no base branch to count against) a head that moved off the base commit. */
function commitState(w: WorktreeInfo): { has: boolean; count: number | null } {
  if (typeof w.ahead === "number") return { has: w.ahead > 0, count: w.ahead };
  const moved = !!w.headSha && !!w.baseCommit && w.headSha !== w.baseCommit;
  return { has: moved, count: moved ? null : 0 };
}

/**
 * The worktrees to offer as interrupted work: on disk, not linked to a chat (`linked` holds the task ids chats use),
 * and either dirty or holding unmerged commits. Newest first.
 */
export function findInterruptedWork(
  list: readonly WorktreeInfo[] | undefined,
  linked: ReadonlySet<string>,
): InterruptedWork[] {
  const out: InterruptedWork[] = [];
  for (const w of list ?? []) {
    if (!w.existsOnDisk || linked.has(w.taskId)) continue;
    const c = commitState(w);
    const files = w.changedFiles > 0 ? w.changedFiles : w.dirty ? 1 : 0;
    if (!files && !c.has) continue;
    out.push({
      taskId: w.taskId,
      branch: w.branch,
      path: w.path,
      commits: c.count,
      files,
      provider: w.provider,
      model: w.model,
      createdAt: w.createdAt,
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Task ids of the workspaces chats are linked to. */
export function linkedTaskIds(chats: readonly { workspace_task_id?: string | null }[]): Set<string> {
  const ids = new Set<string>();
  for (const c of chats)
    if (typeof c.workspace_task_id === "string" && c.workspace_task_id) ids.add(c.workspace_task_id);
  return ids;
}
