import { runAgent, type ApprovalAnswer, type ApprovalRequest, type RunOptions } from "../agent/agent";
import type { Adapter, Msg, Reasoning, TokenUsage } from "../providers/types";
import {
  APPROVAL_TIMEOUT_MS,
  applyPatches,
  capAccess,
  chatTitle,
  finishPatch,
  planTick,
  type RunStatus,
  type ScheduledPrompt,
} from "./scheduledPrompts";

// Execution of scheduled prompts: one unattended agent run per due schedule (`executeScheduledRun`) and the small
// controller that applies the periodic check (`createRunner`). Everything environment-specific (database, provider
// lookup, review copies, notifications) is injected, so the runner and the loop are tested in tests/scheduledRun.test.mjs
// with a scripted model. The glue with the app state is lib/scheduledRuntime.ts.
//
// An unattended run differs from a user message in these ways: access is capped to read-only/auto, Computer Use is off,
// no subagents are offered, only the prompt (not the chat's earlier runs) goes to the model, and an approval request is
// never answered for the user: it is shown to them and, if nobody answers in time, the run is stopped as "needs attention".

export type ScheduledRunDeps = {
  now(): number;
  /** The adapter and flags for the schedule's provider/model, or an error text when it cannot be used. */
  resolve(providerId: string, model: string): Promise<{ adapter: Adapter; supportsTools?: boolean; nativeInstructions?: string[]; /** CLI agents run their own tools and approvals outside our rules, so they only get read-only access. */ ownTools?: boolean } | { error: string }>;
  /** Folder of the project: `null` for a chat without project, `undefined` when the project does not exist any more. */
  projectRoot(projectId: number | null): string | null | undefined;
  allowlist(): string[];
  reasoning(): Reasoning | undefined;
  /** An existing chat to continue (the schedule's last chat, else one with the same title in the project) or null. */
  findChat(projectId: number | null, title: string, preferredId?: number): Promise<number | null>;
  createChat(projectId: number | null, title: string): Promise<number>;
  addMessage(chatId: number, msg: Msg): Promise<number>;
  /** Shadow copy for a writable project (the same mechanism as for a chat); `review: null` runs in the project folder. */
  prepareReview?(root: string, approve: (command: string) => Promise<boolean>): Promise<{ review: { id: string; workspace: string; linked?: string[] } | null; error?: string }>;
  finishReview?(id: string): Promise<void>;
  checkpoint?(root: string): Promise<string | undefined>;
  /** Registers an open approval request (sidebar badge, notification); the returned function ends it. */
  beginApproval(chatId: number, who: string): () => void;
  /** Lists the request for the user to answer; returns a function that withdraws it. */
  askUser(info: { scheduleId: string; chatId: number | null; title: string; command: string }, onAnswer: (ok: boolean) => void): () => void;
  recordUsage(providerId: string, model: string, usage?: TokenUsage): void;
  bumpUsage(providerId: string): void;
  recordResult(providerId: string, error?: string): void;
  onLimits?(providerId: string, windows: import("../providers/types").LimitWindow[]): void;
  /** Text of the note written into the chat when a run does not finish normally. */
  note(kind: "failed" | "attention" | "stopped", detail?: string): string;
  chatChanged?(): void;
  approvalTimeoutMs?: number;
  /** For tests: the agent loop. */
  runAgent?: (o: RunOptions) => Promise<void>;
};

export type RunResult = { status: "success" | "failed" | "attention" | "stopped"; chatId: number | null; error?: string };

const msgText = (text: string, role: Msg["role"] = "user"): Msg => ({ role, parts: [{ type: "text", text }] });

/** Runs one schedule to completion. Never throws: failures come back as `status: "failed"`. */
export async function executeScheduledRun(sc: ScheduledPrompt, deps: ScheduledRunDeps, outer: AbortSignal): Promise<RunResult> {
  const ctl = new AbortController();
  const stopOuter = () => ctl.abort();
  if (outer.aborted) ctl.abort();
  else outer.addEventListener("abort", stopOuter, { once: true });
  let chatId: number | null = null;
  let attention = false;
  let reviewId: string | null = null;
  const fail = async (error: string): Promise<RunResult> => {
    if (chatId !== null) await deps.addMessage(chatId, msgText(deps.note("failed", error), "assistant")).catch(() => {});
    return { status: "failed", chatId, error };
  };
  try {
    const target = await deps.resolve(sc.providerId, sc.model);
    if ("error" in target) return await fail(target.error);
    const projectRoot = deps.projectRoot(sc.projectId);
    if (projectRoot === undefined) return await fail("The project of this schedule no longer exists.");
    const title = chatTitle(sc);
    chatId = (await deps.findChat(sc.projectId, title, sc.lastChatId)) ?? (await deps.createChat(sc.projectId, title));
    deps.chatChanged?.();
    const cid = chatId;
    // The access mode is capped again here: whatever the stored value says, unattended runs never get "full".
    const access = target.ownTools ? "readonly" : capAccess(sc.access);

    // Approvals: shown to the user, never answered automatically. After the timeout the run is stopped as "needs attention".
    const approve = (req: ApprovalRequest) =>
      new Promise<ApprovalAnswer>((resolve) => {
        if (req.kind !== "command" || ctl.signal.aborted) return resolve(false);
        const ended = deps.beginApproval(cid, sc.title);
        let withdraw = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        let done = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ctl.signal.removeEventListener("abort", onAbort);
          withdraw();
          ended();
          resolve(ok);
        };
        const onAbort = () => finish(false);
        ctl.signal.addEventListener("abort", onAbort, { once: true });
        withdraw = deps.askUser({ scheduleId: sc.id, chatId: cid, title: sc.title, command: req.command }, finish);
        timer = setTimeout(() => {
          attention = true;
          ctl.abort();
        }, deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS);
        if (done) clearTimeout(timer);
      });

    let workspace = projectRoot;
    let review: Awaited<ReturnType<NonNullable<ScheduledRunDeps["prepareReview"]>>>["review"] = null;
    if (projectRoot && access !== "readonly" && deps.prepareReview) {
      const made = await deps.prepareReview(projectRoot, (command) => approve({ kind: "command", command }).then(Boolean));
      review = made.review;
      if (review) reviewId = review.id;
      if (made.error) await deps.addMessage(cid, msgText(deps.note("failed", made.error), "assistant")).catch(() => {});
      workspace = review?.workspace ?? projectRoot;
    }

    const cp = projectRoot && deps.checkpoint ? await deps.checkpoint(projectRoot).catch(() => undefined) : undefined;
    const user: Msg = { role: "user", parts: [{ type: "text", text: sc.prompt }], ...(cp ? { meta: { checkpoint: cp } } : {}) };
    await deps.addMessage(cid, user);
    const history: Msg[] = [user];
    deps.bumpUsage(sc.providerId);
    const run = deps.runAgent ?? runAgent;
    await run({
      root: workspace,
      chatId: cid,
      reviewMode: !!review,
      reviewLinked: review?.linked,
      supportsTools: target.supportsTools,
      history,
      adapter: target.adapter,
      providerId: sc.providerId,
      model: sc.model,
      reasoning: deps.reasoning(),
      access,
      computerUse: false,
      nativeInstructions: target.nativeInstructions,
      allowlist: deps.allowlist(),
      signal: ctl.signal,
      source: "scheduled",
      onLimits: (windows) => deps.onLimits?.(sc.providerId, windows),
      onText: () => {},
      onMessage: async (m) => {
        if (ctl.signal.aborted && !m.parts.some((p) => p.type === "tool_result")) return;
        deps.recordUsage(sc.providerId, sc.model, m.meta?.usage);
        await deps.addMessage(cid, m);
      },
      approve,
    });
    if (attention) {
      await deps.addMessage(cid, msgText(deps.note("attention"), "assistant")).catch(() => {});
      return { status: "attention", chatId: cid };
    }
    if (ctl.signal.aborted) {
      await deps.addMessage(cid, msgText(deps.note("stopped"), "assistant")).catch(() => {});
      return { status: "stopped", chatId: cid };
    }
    deps.recordResult(sc.providerId);
    return { status: "success", chatId: cid };
  } catch (e) {
    if (attention) return { status: "attention", chatId };
    if (ctl.signal.aborted) return { status: "stopped", chatId };
    const message = String((e as Error)?.message ?? e);
    deps.recordResult(sc.providerId, message);
    return await fail(message);
  } finally {
    outer.removeEventListener("abort", stopOuter);
    // Like a chat: the copy is removed when nothing was changed in it, otherwise it stays for the review panel.
    if (reviewId && deps.finishReview) await deps.finishReview(reviewId).catch(() => {});
    deps.chatChanged?.();
  }
}

// ---- the controller ----

export type RunnerStore = { get(): ScheduledPrompt[]; update(fn: (list: ScheduledPrompt[]) => ScheduledPrompt[]): void };
export type Runner = {
  /** Applies the periodic check: starts due schedules, records missed ones. */
  tick(): void;
  /** Starts a schedule now (the user asked for it). False while it is already running. */
  runNow(id: string): boolean;
  stop(id: string): void;
  isRunning(id: string): boolean;
  running(): ReadonlySet<string>;
};

/** `execute` runs one schedule; the controller guarantees that a schedule never runs twice at the same time. */
export function createRunner(store: RunnerStore, execute: (sc: ScheduledPrompt, signal: AbortSignal) => Promise<RunResult>, now: () => number = Date.now, onChange?: () => void): Runner {
  const active = new Map<string, AbortController>();
  const start = (sc: ScheduledPrompt) => {
    const ctl = new AbortController();
    active.set(sc.id, ctl);
    onChange?.();
    execute(sc, ctl.signal)
      .catch((e): RunResult => ({ status: "failed", chatId: null, error: String((e as Error)?.message ?? e) }))
      .then((r) => store.update((list) => applyPatches(list, [{ id: sc.id, patch: finishPatch(r.status, r.chatId, r.error) }])))
      .finally(() => {
        active.delete(sc.id);
        onChange?.();
      });
  };
  return {
    tick() {
      const plan = planTick(store.get(), now(), new Set(active.keys()));
      if (!plan.patches.length) return;
      store.update((list) => applyPatches(list, plan.patches));
      for (const id of plan.start) {
        const sc = store.get().find((s) => s.id === id);
        if (sc && !active.has(id)) start(sc);
      }
    },
    runNow(id) {
      const sc = store.get().find((s) => s.id === id);
      if (!sc || active.has(id)) return false;
      store.update((list) => applyPatches(list, [{ id, patch: { lastRunAt: now(), lastStatus: "running" satisfies RunStatus, lastError: undefined } }]));
      start(sc);
      return true;
    },
    stop: (id) => active.get(id)?.abort(),
    isRunning: (id) => active.has(id),
    running: () => new Set(active.keys()),
  };
}
