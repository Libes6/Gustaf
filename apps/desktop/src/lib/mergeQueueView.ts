// Pure view model of the merge queue UI (status labels, ordering, error mapping, the conflict badge, the conflict
// resolver draft). No React, no Tauri: Node runs this file directly in tests/mergeQueueView.test.mjs, so only
// `import type` plus the pure `./mergeQueue.ts` may be imported.
import type { Key } from "../i18n";
import {
  isTerminalStatus, parseMergeQueueError,
  type ConflictCheck, type ConflictEntry, type ConflictKind, type ConflictsReport, type MergeQueueErrorCode, type MergeStrategy,
  type QueueItem, type QueueItemStatus, type QueueState,
} from "./mergeQueue.ts";

export const STRATEGIES: readonly MergeStrategy[] = ["merge", "fast_forward", "squash"];
export const DEFAULT_STRATEGY: MergeStrategy = "merge";
/** Per-project default strategy lives in the settings table under this key. */
export const mergeStrategyKey = (root: string) => `mergeStrategy:${root}`;

/** Whatever was stored (including garbage) as a valid strategy; `merge` when unknown. */
export const normalizeStrategy = (v: unknown): MergeStrategy => (STRATEGIES as readonly unknown[]).includes(v) ? (v as MergeStrategy) : DEFAULT_STRATEGY;

export const strategyKey = (s: MergeStrategy): Key => `mqStrategy_${s}`;
export const strategyHintKey = (s: MergeStrategy): Key => `mqStrategyHint_${s}`;
export const statusKey = (s: QueueItemStatus): Key => `mqStatus_${s}`;

export type StatusTone = "pending" | "active" | "ok" | "fail" | "skipped";
export const statusTone = (s: QueueItemStatus): StatusTone =>
  s === "merged" ? "ok" : s === "failed" ? "fail" : s === "skipped" ? "skipped" : s === "queued" ? "pending" : "active";

// ---- ordering ---------------------------------------------------------------------------------------------------

/** Moves one entry; out-of-range or no-op moves return a copy unchanged. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from === to || from < 0 || to < 0 || from >= out.length || to >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** Checked task ids in the order of `order` (the user's ordering); ids not in `order` are appended in their own order. */
export function orderedSelection(order: readonly string[], checked: ReadonlySet<string>): string[] {
  const listed = order.filter((id) => checked.has(id));
  const rest = [...checked].filter((id) => !order.includes(id));
  return [...listed, ...rest];
}

/** Toggles a task in the ordered list: checked ones keep their position, a newly checked one goes to the end of the checked block. */
export function toggleInOrder(order: readonly string[], checked: ReadonlySet<string>, taskId: string): { order: string[]; checked: Set<string> } {
  const next = new Set(checked);
  if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
  return { order: order.includes(taskId) ? order.slice() : [...order, taskId], checked: next };
}

// ---- queue state ------------------------------------------------------------------------------------------------

export type QueueSummary = { total: number; queued: number; running: number; merged: number; failed: number; skipped: number; done: boolean };

export function summarizeQueue(state: QueueState | null | undefined): QueueSummary {
  const items = state?.items ?? [];
  const count = (f: (i: QueueItem) => boolean) => items.filter(f).length;
  const unfinished = count((i) => !isTerminalStatus(i.status));
  return {
    total: items.length,
    queued: count((i) => i.status === "queued"),
    running: count((i) => i.status === "rebasing" || i.status === "testing" || i.status === "merging"),
    merged: count((i) => i.status === "merged"),
    failed: count((i) => i.status === "failed"),
    skipped: count((i) => i.status === "skipped"),
    done: items.length > 0 && unfinished === 0,
  };
}

/** The queue still has work (an unfinished item), possibly halted. */
export const hasUnfinished = (state: QueueState | null | undefined) => !!state?.items.some((i) => !isTerminalStatus(i.status));

/**
 * The items of the batch on screen, in queue order: the unfinished ones, the finished ones enqueued together with them
 * (at or after the oldest unfinished one) and the task ids this dialog started (`started`). Older history is left out.
 */
export function currentBatch(state: QueueState | null | undefined, started: readonly string[] = []): QueueItem[] {
  const items = state?.items ?? [];
  // A halted queue keeps its failed item on screen (it is what Resume retries), even when nothing else is waiting.
  const open = items.filter((i) => !isTerminalStatus(i.status) || (state?.halted && i.status === "failed"));
  const base = open.length ? Math.min(...open.map((i) => i.enqueuedAt)) : Infinity;
  return items.filter((i) => !isTerminalStatus(i.status) || i.enqueuedAt >= base || started.includes(i.taskId));
}

/** The most recent finished items, newest first, for the "Recent results" list. */
export function recentResults(state: QueueState | null | undefined, limit = 5): QueueItem[] {
  return (state?.items ?? []).filter((i) => isTerminalStatus(i.status)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)).slice(0, limit);
}

/** The failed item that halted the queue (the first one), if any. */
export const haltingItem = (state: QueueState | null | undefined): QueueItem | null =>
  state?.halted ? state.items.find((i) => i.status === "failed") ?? null : null;

// ---- errors -----------------------------------------------------------------------------------------------------

export type ErrorView = { key: Key; vars: Record<string, string | number>; /** The fix can be applied and the same call retried. */ retryable: boolean };

/** Plain-language message (and the fix) for a typed backend error. `detail` is the backend's own text (counts, names). */
export function errorView(raw: unknown): ErrorView {
  const e = parseMergeQueueError(raw);
  const vars = { detail: e.message };
  const codeMap: Partial<Record<MergeQueueErrorCode, { key: Key; retryable: boolean }>> = {
    target_dirty: { key: "mqErr_target_dirty", retryable: true },
    target_not_checked_out: { key: "mqErr_target_not_checked_out", retryable: true },
    dirty: { key: "mqErr_dirty", retryable: false },
    queue_busy: { key: "mqErr_queue_busy", retryable: true },
    already_queued: { key: "mqErr_already_queued", retryable: false },
    not_found: { key: "mqErr_not_found", retryable: false },
    git_too_old: { key: "mqErr_git_too_old", retryable: false },
    invalid_strategy: { key: "mqErr_invalid_strategy", retryable: false },
    not_a_git_repo: { key: "mqErr_not_a_git_repo", retryable: false },
    bare_repo: { key: "mqErr_not_a_git_repo", retryable: false },
    no_commits: { key: "mqErr_no_commits", retryable: false },
  };
  const hit = codeMap[e.code];
  return hit ? { key: hit.key, vars, retryable: hit.retryable } : { key: "mqErrGeneric", vars: { detail: e.message, code: e.code }, retryable: false };
}

// ---- conflict badge ---------------------------------------------------------------------------------------------

export const CONFLICT_CHECK_MS = 30_000;

export type ConflictGroup = { against: string; againstTaskId: string | null; target: boolean; files: ConflictEntry[]; truncated: boolean };
export type ConflictBadge = {
  /** The comparison shown in the badge text: the target branch when it conflicts, else the first workspace. */
  against: string;
  againstTaskId: string | null;
  target: boolean;
  files: number;
  /** Further conflicting comparisons not named in the text. */
  more: number;
  groups: ConflictGroup[];
};

/** The badge for one workspace, or null when every check is clean (or there is no report). */
export function conflictBadge(report: ConflictsReport | null | undefined): ConflictBadge | null {
  if (!report) return null;
  const groups: ConflictGroup[] = report.checks
    .filter((c: ConflictCheck) => !c.clean && c.conflicts.length > 0)
    .map((c) => ({ against: c.against, againstTaskId: c.againstTaskId, target: c.againstTaskId === null, files: c.conflicts, truncated: c.truncated }));
  if (!groups.length) return null;
  const first = groups[0];
  return { against: first.against, againstTaskId: first.againstTaskId, target: first.target, files: first.files.length, more: groups.length - 1, groups };
}

export const conflictKindKey = (k: ConflictKind): Key => (k === "other" ? "mqKindOther" : `mqKind_${k}`);

/** True when a new conflict check is allowed: nothing yet, a different comparison set, or older than the throttle. */
export function shouldCheckConflicts(o: { lastAt: number | null; lastSignature: string | null; signature: string; now: number; force?: boolean }): boolean {
  if (o.force || o.lastAt === null) return true;
  if (o.lastSignature !== o.signature) return true;
  return o.now - o.lastAt >= CONFLICT_CHECK_MS;
}

/** A workspace takes part in conflict checks when its branch has commits beyond its base (nothing to merge otherwise). */
export const takesPartInConflictCheck = (w: { existsOnDisk: boolean; ahead: number | null }) => w.existsOnDisk && (w.ahead ?? 1) > 0;

// ---- conflict resolver draft -----------------------------------------------------------------------------------

/**
 * The instruction put into a workspace chat's composer (never sent automatically) after a merge failed with conflicts.
 * The agent must keep both intents, run the tests, commit and not push. `t` is the UI translator.
 */
export function resolveDraft(o: { target: string; files: readonly ConflictEntry[]; testCommand?: string | null; t: (key: Key, vars?: Record<string, string | number>) => string }): string {
  const command = o.testCommand?.trim();
  const files = o.files.map((f) => `- ${f.path} (${o.t(conflictKindKey(f.kind))})`).join("\n");
  const tests = command ? o.t("mqResolveTests", { command }) : o.t("mqResolveNoTests");
  return o.t("mqResolveDraft", { target: o.target, files, tests });
}

/** Item-level message when a halt came from a failed test (no conflicts): the stored error, shortened. */
export const itemErrorText = (item: QueueItem, max = 600): string => (item.error ?? "").slice(-max);
