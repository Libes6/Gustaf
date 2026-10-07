import { useEffect, useSyncExternalStore } from "react";
import { getRulesConfig } from "../agent/rulesStore";
import { DEFAULT_RULES } from "../agent/rules";
import { loadDiagnostics } from "../agent/diagnostics";
import { fsx, getSetting, setSetting } from "./api";
import { commandVerdict, type CommandAccess } from "./commandRules";
import {
  MergeQueueError,
  mergeQueue,
  parseMergeQueueError,
  type ConflictsReport,
  type MergeStrategy,
  type NeedsTest,
  type QueueState,
} from "./mergeQueue";
import {
  haltingItem,
  mergeStrategyKey,
  normalizeStrategy,
  shouldCheckConflicts,
  takesPartInConflictCheck,
} from "./mergeQueueView";
import { summarizeRun, TEST_TIMEOUT_MS } from "./reviewSetup";
import { loadReviewSetup } from "./reviewSetupStore";
import { joinCheckout } from "./workspaces";
import { refreshWorkspaces, repoPrefix } from "./workspaceStore";
import type { WorktreeInfo } from "./worktrees";

// External stores for the orchestrator UI: conflict checks per workspace (sidebar badges) and the merge queue run per
// project root. The queue loop lives here (not in a dialog) so closing the dialog never stops it; the queue itself is
// persisted by the backend, so after a restart `loadQueue` shows where it stood.

const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
/** Re-renders the caller whenever a conflict report or a queue changes. */
export const useMergeQueueVersion = () => useSyncExternalStore(subscribe, () => version);

// ---- conflict checks ----------------------------------------------------------------------------------------------

type ConflictEntryState = { report: ConflictsReport | null; at: number; signature: string };
const conflictEntries = new Map<string, ConflictEntryState>();
const conflictInflight = new Map<string, Promise<void>>();
/** Roots whose git is too old for `merge-tree --write-tree`: never asked again this session. */
const tooOld = new Set<string>();
const ckey = (root: string, taskId: string) => `${root}\n${taskId}`;

export const conflictReport = (root: string | null | undefined, taskId: string): ConflictsReport | null =>
  root ? (conflictEntries.get(ckey(root, taskId))?.report ?? null) : null;

/**
 * Checks every workspace of `root` that has something to merge against the target and against each other, one after
 * the other (never in parallel, never blocking the caller). Per workspace it is skipped while the last check is
 * younger than `CONFLICT_CHECK_MS` and the set of other workspaces is unchanged, unless `force`.
 */
export function refreshConflicts(
  root: string,
  list: readonly WorktreeInfo[] | undefined,
  o: { force?: boolean } = {},
): Promise<void> {
  if (!list || tooOld.has(root)) return Promise.resolve();
  const running = conflictInflight.get(root);
  if (running) return running;
  const eligible = list.filter(takesPartInConflictCheck);
  const ids = eligible.map((w) => w.taskId);
  const p = (async () => {
    // Forget reports of workspaces that no longer take part (archived, merged and level with the base).
    for (const k of [...conflictEntries.keys()])
      if (k.startsWith(`${root}\n`) && !ids.includes(k.slice(root.length + 1))) conflictEntries.delete(k);
    for (const w of eligible) {
      const others = ids.filter((id) => id !== w.taskId);
      const signature = others.join(",");
      const last = conflictEntries.get(ckey(root, w.taskId));
      if (
        !shouldCheckConflicts({
          lastAt: last?.at ?? null,
          lastSignature: last?.signature ?? null,
          signature,
          now: Date.now(),
          force: o.force,
        })
      )
        continue;
      try {
        const report = await mergeQueue.conflicts(root, w.taskId, others);
        conflictEntries.set(ckey(root, w.taskId), { report, at: Date.now(), signature });
      } catch (e) {
        if (parseMergeQueueError(e).code === "git_too_old") {
          tooOld.add(root);
          conflictEntries.clear();
          emit();
          return;
        }
        conflictEntries.set(ckey(root, w.taskId), { report: null, at: Date.now(), signature });
      }
      emit();
    }
  })().finally(() => {
    conflictInflight.delete(root);
  });
  conflictInflight.set(root, p);
  return p;
}

/**
 * Sidebar hook: checks the given project roots (the expanded ones that have workspaces) when they open, when their
 * set of workspaces changes and when `refreshKey` changes (a run started or ended). Throttled by `refreshConflicts`.
 */
export function useConflictChecks(
  roots: readonly { root: string; list: readonly WorktreeInfo[] | undefined }[],
  refreshKey: string,
) {
  const key =
    roots
      .map(
        (r) =>
          `${r.root}:${(r.list ?? [])
            .filter(takesPartInConflictCheck)
            .map((w) => w.taskId)
            .join(",")}`,
      )
      .join("|") + `#${refreshKey}`;
  useEffect(() => {
    for (const r of roots) void refreshConflicts(r.root, r.list);
  }, [key]);
}

// ---- merge queue ------------------------------------------------------------------------------------------------

export type QueuePolicy = {
  access: CommandAccess;
  allowlist: string[];
  /** Texts stored as the test output when the command is not run. */
  texts: { declined: string; blocked: string };
};

export type QueueApproval = { taskId: string; command: string; cwd: string };
export type QueueRunView = {
  state: QueueState | null;
  loaded: boolean;
  /** The loop is running (a git step, a test or an approval is in progress). */
  busy: boolean;
  error: MergeQueueError | null;
  /** The test command is running for this task. */
  testing: { taskId: string; command: string } | null;
  /** The command waits for the user's approval (the rules said `ask`). */
  approval: QueueApproval | null;
  /** Result of the last test run, for the failure details. */
  lastTest: { taskId: string; ok: boolean; output: string } | null;
};

const emptyRun: QueueRunView = {
  state: null,
  loaded: false,
  busy: false,
  error: null,
  testing: null,
  approval: null,
  lastTest: null,
};
const runs = new Map<string, QueueRunView>();
const approvals = new Map<string, (ok: boolean) => void>();
const stopRequested = new Set<string>();
const policies = new Map<string, QueuePolicy>();
const loops = new Map<string, Promise<void>>();

export const queueRun = (root: string | null | undefined): QueueRunView =>
  root ? (runs.get(root) ?? emptyRun) : emptyRun;
const patch = (root: string, p: Partial<QueueRunView>) => {
  runs.set(root, { ...queueRun(root), ...p });
  emit();
};

export function useQueueRun(root: string | null | undefined): QueueRunView {
  useSyncExternalStore(subscribe, () => version);
  return queueRun(root);
}

const fail = (root: string, e: unknown) => patch(root, { error: parseMergeQueueError(e), busy: false });

/** Reads the persisted queue (after a restart or when the dialog opens). */
export async function loadQueue(root: string): Promise<void> {
  try {
    patch(root, { state: await mergeQueue.status(root), loaded: true });
  } catch (e) {
    patch(root, { loaded: true, error: parseMergeQueueError(e) });
  }
}

export const clearQueueError = (root: string) => patch(root, { error: null });

/** The test command a new queue starts with: the project's review-setup test command, else its diagnostics command. */
export async function defaultTestCommand(root: string): Promise<string> {
  const setup = await loadReviewSetup(root).catch(() => null);
  if (setup?.testCommand) return setup.testCommand;
  const diag = await loadDiagnostics(root).catch(() => null);
  return diag?.enabled && diag.command ? diag.command : "";
}

export const loadDefaultStrategy = async (root: string): Promise<MergeStrategy> =>
  normalizeStrategy(await getSetting<unknown>(mergeStrategyKey(root), null).catch(() => null));

type TestResult = { ok: boolean; output: string };

/** Runs the test command in the workspace THROUGH the command rules: allowed ones run, `ask` waits for the user, `block` is refused. */
async function runTest(root: string, needs: NeedsTest, policy: QueuePolicy): Promise<TestResult | "stopped"> {
  const cwd = joinCheckout(needs.worktreePath, await repoPrefix(root));
  const verdict = commandVerdict(
    policy.access,
    needs.command,
    policy.allowlist,
    await getRulesConfig().catch(() => DEFAULT_RULES),
    root,
  );
  if (verdict === "block") return { ok: false, output: policy.texts.blocked };
  if (verdict === "ask") {
    const answer = new Promise<boolean>((resolve) => approvals.set(root, resolve));
    patch(root, { approval: { taskId: needs.taskId, command: needs.command, cwd } });
    const ok = await answer;
    approvals.delete(root);
    patch(root, { approval: null });
    if (stopRequested.has(root)) return "stopped";
    if (!ok) return { ok: false, output: policy.texts.declined };
  }
  patch(root, { testing: { taskId: needs.taskId, command: needs.command } });
  try {
    const r = summarizeRun(needs.command, await fsx.run(cwd, needs.command, TEST_TIMEOUT_MS));
    return { ok: r.ok, output: r.timedOut ? `${r.output}\n(timed out)` : r.output };
  } catch (e) {
    return { ok: false, output: String((e as Error)?.message ?? e) };
  } finally {
    patch(root, { testing: null });
  }
}

/** Answers the pending test-command approval (`ok` false declines: the test counts as failed and the queue halts). */
export const answerQueueApproval = (root: string, ok: boolean) => approvals.get(root)?.(ok);

async function loop(root: string): Promise<void> {
  const policy = policies.get(root)!;
  patch(root, { busy: true, error: null });
  try {
    for (;;) {
      if (stopRequested.has(root)) return;
      // The backend writes each step (rebasing, testing, merging) as it goes and `queue_status` takes no lock, so poll it for live status.
      let returned = false;
      const poll = setInterval(() => {
        void mergeQueue.status(root).then(
          (s) => {
            if (!returned) patch(root, { state: s });
          },
          () => {},
        );
      }, 1000);
      let result;
      try {
        result = await mergeQueue.runNext(root);
      } finally {
        returned = true;
        clearInterval(poll);
      }
      patch(root, { state: result.state });
      if (result.outcome === "merged" || result.outcome === "skipped") {
        void refreshWorkspaces(root, { force: true });
        continue;
      }
      if (result.outcome === "needs_test" && result.needsTest) {
        const test = await runTest(root, result.needsTest, policy);
        if (test === "stopped" || stopRequested.has(root)) return;
        patch(root, { lastTest: { taskId: result.needsTest.taskId, ok: test.ok, output: test.output } });
        patch(root, {
          state: await mergeQueue.reportTest({
            root,
            taskId: result.needsTest.taskId,
            ok: test.ok,
            output: test.output,
          }),
        });
        if (!test.ok) return;
        continue;
      }
      return; // idle, halted, failed
    }
  } catch (e) {
    fail(root, e);
  } finally {
    patch(root, { busy: false });
    void refreshWorkspaces(root, { force: true });
  }
}

/** Starts (or continues) the loop for `root`; one loop per root. Resolves when it stops. */
export function driveQueue(root: string, policy: QueuePolicy): Promise<void> {
  policies.set(root, policy);
  const running = loops.get(root);
  if (running) return running;
  stopRequested.delete(root);
  const p = loop(root)
    .then(async () => {
      // A cancel asked while the loop was working is applied once it has stopped (the backend refuses it mid-step).
      if (stopRequested.delete(root)) {
        try {
          patch(root, { state: await mergeQueue.cancel(root) });
        } catch (e) {
          fail(root, e);
        }
      }
    })
    .finally(() => {
      loops.delete(root);
    });
  loops.set(root, p);
  return p;
}

/** Queues the workspaces (remembering `strategy` as the project's default) and runs the queue. Typed errors land in `error`. */
export async function startQueue(
  root: string,
  o: { taskIds: string[]; strategy: MergeStrategy; testCommand: string },
  policy: QueuePolicy,
): Promise<void> {
  patch(root, { error: null, lastTest: null });
  try {
    await setSetting(mergeStrategyKey(root), o.strategy).catch(() => {});
    patch(root, {
      state: await mergeQueue.enqueue({
        root,
        taskIds: o.taskIds,
        strategy: o.strategy,
        testCommand: o.testCommand.trim() || null,
      }),
      loaded: true,
    });
  } catch (e) {
    return fail(root, e);
  }
  await driveQueue(root, policy);
}

/**
 * After a failure: queues the failed item again (so it is retried after the remaining ones; skipped with `retry: false`),
 * clears the halt and continues. Re-queueing is refused with `dirty` while the workspace has uncommitted changes.
 */
export async function resumeQueue(root: string, policy: QueuePolicy, o: { retry?: boolean } = {}): Promise<void> {
  patch(root, { error: null });
  try {
    const failed = (o.retry ?? true) ? haltingItem(queueRun(root).state) : null;
    if (failed)
      await mergeQueue.enqueue({
        root,
        taskIds: [failed.taskId],
        strategy: failed.strategy,
        testCommand: failed.testCommand,
      });
    patch(root, { state: await mergeQueue.resume(root) });
  } catch (e) {
    return fail(root, e);
  }
  await driveQueue(root, policy);
}

/** Skips every unfinished item; if the loop is working it stops at the next step and the cancel is applied then. */
export async function cancelQueue(root: string): Promise<void> {
  patch(root, { error: null });
  if (loops.has(root)) {
    stopRequested.add(root);
    answerQueueApproval(root, false);
    await loops.get(root);
    return;
  }
  try {
    patch(root, { state: await mergeQueue.cancel(root) });
  } catch (e) {
    fail(root, e);
  }
}

/** Continues a queue that is not halted but has unfinished items and no loop (after a restart or a retryable error). */
export const continueQueue = (root: string, policy: QueuePolicy) => driveQueue(root, policy);

/** Test hook. */
export function resetMergeQueueStore() {
  conflictEntries.clear();
  conflictInflight.clear();
  tooOld.clear();
  runs.clear();
  approvals.clear();
  stopRequested.clear();
  policies.clear();
  loops.clear();
  emit();
}
