// Typed wrappers for the conflict check and merge queue commands in src-tauri/src/merge_queue.rs. The backend
// rejects with "<code>: <message>"; `parseMergeQueueError` turns that into a `MergeQueueError` so callers can branch
// on `code`. Pure logic is unit-tested in tests/mergeQueue.test.mjs, so only `import type` and a lazy Tauri import
// are used here (Node runs this file).
//
// The queue never runs the test command itself: `runNext` answers `needs_test` with the command and the workspace
// path, the caller runs it through the normal command-approval path and then calls `reportTest`.

export const MERGE_QUEUE_ERROR_CODES = [
  // as in worktrees.ts
  "not_a_git_repo",
  "bare_repo",
  "no_commits",
  "invalid_task_id",
  "not_found",
  "dirty",
  "unsafe_path",
  "invalid_root",
  "git_error",
  // merge queue
  "git_too_old",
  "target_dirty",
  "target_not_checked_out",
  "already_queued",
  "queue_busy",
  "invalid_strategy",
  "invalid_request",
  "invalid_state",
  "state_error",
] as const;
export type MergeQueueErrorCode = (typeof MERGE_QUEUE_ERROR_CODES)[number];

export type MergeStrategy = "merge" | "fast_forward" | "squash";
export type QueueItemStatus = "queued" | "rebasing" | "testing" | "merging" | "merged" | "failed" | "skipped";
export type ConflictKind = "content" | "add_add" | "modify_delete" | "other";

export type ConflictEntry = { path: string; kind: ConflictKind };
export type ConflictCheck = {
  clean: boolean;
  conflicts: ConflictEntry[];
  truncated: boolean;
  /** The other workspace's task id; null for the check against the target branch. */
  againstTaskId: string | null;
  /** The target branch name, or the other workspace's branch. */
  against: string;
};
export type ConflictsReport = {
  taskId: string;
  branch: string;
  target: string;
  /** True when every check is clean. */
  clean: boolean;
  /** First entry: the target branch; then one per task id passed as `against`. */
  checks: ConflictCheck[];
};

export type QueueItem = {
  taskId: string;
  branch: string;
  status: QueueItemStatus;
  error: string | null;
  conflicts: ConflictEntry[];
  strategy: MergeStrategy;
  testCommand: string | null;
  targetBranch: string;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
};
export type QueueState = {
  version: number;
  /** A failure stopped the queue: call `resume` (or `cancel`) before `runNext` does anything again. */
  halted: boolean;
  items: QueueItem[];
  updatedAt: number;
};

export type RunOutcome = "idle" | "halted" | "needs_test" | "merged" | "failed" | "skipped";
export type NeedsTest = { taskId: string; worktreePath: string; command: string };
export type RunResult = { outcome: RunOutcome; taskId: string | null; needsTest: NeedsTest | null; state: QueueState };

export class MergeQueueError extends Error {
  code: MergeQueueErrorCode;
  constructor(code: MergeQueueErrorCode, message: string) {
    super(message);
    this.name = "MergeQueueError";
    this.code = code;
  }
}

/** Maps whatever `invoke` rejected with to a `MergeQueueError`; unknown shapes become `git_error`. */
export function parseMergeQueueError(raw: unknown): MergeQueueError {
  if (raw instanceof MergeQueueError) return raw;
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);
  const m = /^([a-z_]+): ([\s\S]*)$/.exec(text);
  if (m && (MERGE_QUEUE_ERROR_CODES as readonly string[]).includes(m[1]))
    return new MergeQueueError(m[1] as MergeQueueErrorCode, m[2]);
  return new MergeQueueError("git_error", text);
}

/** Errors that mean "fix the main checkout, then call `runNext` again": the item stays queued. */
export const isRetryableTargetError = (e: unknown): boolean => {
  const code = parseMergeQueueError(e).code;
  return code === "target_dirty" || code === "target_not_checked_out" || code === "queue_busy";
};

export const isTerminalStatus = (s: QueueItemStatus): boolean => s === "merged" || s === "failed" || s === "skipped";

/** The item `runNext` would work on next, or null when the queue is empty or finished. */
export const nextQueueItem = (state: QueueState): QueueItem | null =>
  state.items.find((i) => !isTerminalStatus(i.status)) ?? null;

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw parseMergeQueueError(e);
  }
}

export const mergeQueue = {
  /**
   * Read-only `git merge-tree --write-tree` check of a workspace branch against its target branch and, when
   * `against` lists other workspace task ids, against those branches. Rejects with "git_too_old" before git 2.38.
   */
  conflicts: (root: string, taskId: string, against?: string[]) =>
    call<ConflictsReport>("conflicts_check", { root, taskId, against: against ?? null }),
  /** Queues workspaces (all or none). Rejects "dirty", "not_found", "already_queued", "invalid_strategy". */
  enqueue: (a: { root: string; taskIds: string[]; strategy: MergeStrategy; testCommand?: string | null }) =>
    call<QueueState>("queue_enqueue", {
      root: a.root,
      taskIds: a.taskIds,
      strategy: a.strategy,
      testCommand: a.testCommand ?? null,
    }),
  status: (root: string) => call<QueueState>("queue_status", { root }),
  /** Skips every unfinished item and clears the halt. Rejects "queue_busy" while a run is active. */
  cancel: (root: string) => call<QueueState>("queue_cancel", { root }),
  /** Clears the halt after a failure so the remaining queued items can run. */
  resume: (root: string) => call<QueueState>("queue_resume", { root }),
  /**
   * Processes exactly one item. Rejects "target_dirty" / "target_not_checked_out" (item untouched, retry after
   * fixing the main checkout) and "queue_busy" (another run is active).
   */
  runNext: (root: string) => call<RunResult>("queue_run_next", { root }),
  /** Result of the test command for the item `runNext` reported as `needs_test`; a pass lets the next `runNext` merge it. */
  reportTest: (a: { root: string; taskId: string; ok: boolean; output?: string | null }) =>
    call<QueueState>("queue_report_test", { root: a.root, taskId: a.taskId, ok: a.ok, output: a.output ?? null }),
};
