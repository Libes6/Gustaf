// Typed wrappers for the git-worktree workspace commands in src-tauri/src/worktree.rs. The backend rejects with
// "<code>: <message>"; `parseWorktreeError` turns that into a `WorktreeError` so callers can branch on `code`
// (for example fall back to the shadow copy on "not_a_git_repo"). Pure logic is unit-tested in
// tests/worktrees.test.mjs, so only `import type` and a lazy Tauri import are used here (Node runs this file).

export const WORKTREE_ERROR_CODES = [
  "not_a_git_repo", "bare_repo", "no_commits", "invalid_task_id", "invalid_base", "task_exists",
  "not_found", "dirty", "unsafe_path", "invalid_root", "git_error",
] as const;
export type WorktreeErrorCode = (typeof WORKTREE_ERROR_CODES)[number];

export type WorktreeInfo = {
  taskId: string; path: string; branch: string; baseCommit: string; baseBranch: string | null; createdAt: number;
  provider: string | null; model: string | null; headSha: string | null; changedFiles: number;
  ahead: number | null; behind: number | null; dirty: boolean; existsOnDisk: boolean;
};
export type WorktreeRemoveResult = { removed: boolean; branchDeleted: boolean; branchKeptReason: string | null };
export type WorktreePruneResult = { removed: string[] };
export type WorktreeDiffFile = { path: string; status: "added" | "modified" | "deleted" | "untracked"; additions: number; deletions: number; binary: boolean };
export type WorktreeDiff = { base: string; files: WorktreeDiffFile[]; truncated: boolean };

export class WorktreeError extends Error {
  code: WorktreeErrorCode;
  constructor(code: WorktreeErrorCode, message: string) {
    super(message);
    this.name = "WorktreeError";
    this.code = code;
  }
}

/** Maps whatever `invoke` rejected with to a `WorktreeError`; unknown shapes become `git_error`. */
export function parseWorktreeError(raw: unknown): WorktreeError {
  if (raw instanceof WorktreeError) return raw;
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
  if (m && (WORKTREE_ERROR_CODES as readonly string[]).includes(m[1])) return new WorktreeError(m[1] as WorktreeErrorCode, m[2]);
  return new WorktreeError("git_error", text);
}

/** True when the caller should fall back to the shadow copy (no usable git repository for this project). */
export const needsShadowCopyFallback = (e: unknown): boolean => {
  const code = parseWorktreeError(e).code;
  return code === "not_a_git_repo" || code === "bare_repo" || code === "no_commits";
};

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw parseWorktreeError(e);
  }
}

export const worktrees = {
  /** `git worktree add` under the app data dir on a new `gustaf/<slug>` branch from `base` (default HEAD). */
  create: (a: { root: string; taskId: string; slug: string; base?: string | null; provider?: string | null; model?: string | null }) =>
    call<WorktreeInfo>("worktree_create", { root: a.root, base: a.base ?? null, slug: a.slug, taskId: a.taskId, provider: a.provider ?? null, model: a.model ?? null }),
  list: (root: string) => call<WorktreeInfo[]>("worktree_list", { root }),
  /** Rejects with code "dirty" when there are uncommitted changes and `force` is not set. */
  remove: (a: { root: string; taskId: string; force?: boolean; deleteBranch?: boolean }) =>
    call<WorktreeRemoveResult>("worktree_remove", { root: a.root, taskId: a.taskId, force: !!a.force, deleteBranch: !!a.deleteBranch }),
  prune: (root: string) => call<WorktreePruneResult>("worktree_prune", { root }),
  diff: (root: string, taskId: string) => call<WorktreeDiff>("worktree_diff", { root, taskId }),
};
