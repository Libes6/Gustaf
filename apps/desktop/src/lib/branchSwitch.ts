import type { BranchEntry } from "./api";

export type LockReason = "worktree" | "running" | "review" | "op";

/** Why the branch cannot be switched right now (first match wins), or null. A worktree chat never switches. */
export function lockReason(s: { worktree: boolean; running: boolean; reviewPending: boolean; inProgress: string | null }): LockReason | null {
  if (s.worktree) return "worktree";
  if (s.running) return "running";
  if (s.reviewPending) return "review";
  if (s.inProgress) return "op";
  return null;
}

/** Backend errors look like `dirty: 3` or `git_error: ...`; anything else has no code. */
export function branchErrorCode(text: string): { code: string; rest: string } {
  const m = /^(not_a_repo|dirty|in_progress|unknown_branch|checked_out_elsewhere|invalid_name|git_error):\s*([\s\S]*)$/.exec(text.trim());
  return m ? { code: m[1], rest: m[2].trim() } : { code: "", rest: text.trim() };
}

/** Case-insensitive substring match on the branch name. */
export function filterBranches(branches: BranchEntry[], query: string): BranchEntry[] {
  const q = query.trim().toLowerCase();
  return q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
}

/** The typed text as a new branch name, when it looks valid (git has the final say) and no local branch has it. */
export function canCreateBranch(query: string, branches: BranchEntry[]): string | null {
  const name = query.trim();
  if (!name || name.length > 200 || name.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{|\/\/|\.lock$|[/.]$|^\/|^@$/.test(name)) return null;
  return branches.some((b) => !b.remote && b.name === name) ? null : name;
}
