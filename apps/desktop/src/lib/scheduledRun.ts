import { loadQueue, updateQueue } from "./chatQueue";
import { waitForChat } from "./chatCoordinator";
import type { Adapter, Msg, Reasoning, TurnInput } from "../providers/types";
import { appendUserMessage, createApprover, finishReviewCopy, reportRunFailure, runChatCore, type ChatRunDeps, type ReviewCopy } from "./chatRunCore";
import type { LiveRunHandle } from "./liveRuns";
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
// The run itself (checkpoint, shadow copy, agent loop, storing messages, usage, finishing the copy, approval flow) is the
// same code as an interactive send: lib/chatRunCore.ts. An unattended run differs from a user message in these ways, all
// decided here: access is capped to read-only/auto, Computer Use is off, no subagents (and no MCP) are offered, only the
// prompt (not the chat's earlier runs) goes to the model, and an approval request is never answered for the user: it is
// shown to them and, if nobody answers in time, the run is stopped as "needs attention". While it runs, the chat is live in
// the UI (lib/liveRuns.ts): streamed text, tool cards and approvals are reported to `deps.live`.

export type ScheduledRunDeps = ChatRunDeps & {
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
  /** Registers an open approval request (sidebar badge, notification); the returned function ends it. */
  beginApproval(chatId: number, who: string): () => void;
  /** Lists the request for the user to answer; returns a function that withdraws it. */
  askUser(info: { scheduleId: string; chatId: number | null; title: string; command: string }, onAnswer: (ok: boolean) => void): () => void;
  /** Makes the run visible in an open chat (live text, tool cards, approval, Stop) and in the sidebar. `abort` is Stop. */
  live?(chatId: number, title: string, abort: () => void): LiveRunHandle;
  /** Text of the "retrying in N seconds" line shown in the live chat. */
  retryNotice?(info: Parameters<NonNullable<TurnInput["onRetry"]>>[0]): string;
  /** Text of the note written into the chat when a run does not finish normally. */
  note(kind: "failed" | "attention" | "stopped", detail?: string): string;
  chatChanged?(): void;
  approvalTimeoutMs?: number;
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
  let release: (() => void) | undefined;
  let succeeded = false;
  let attention = false;
  let review: ReviewCopy | null = null;
  let live: LiveRunHandle | undefined;
  const fail = async (error: string): Promise<RunResult> => {
    if (chatId !== null && release) await deps.addMessage(chatId, msgText(deps.note("failed", error), "assistant")).catch(() => {});
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
    release = await waitForChat(cid, ctl.signal);
    await loadQueue(cid);
    await updateQueue(cid, q => ({ ...q, interrupted: true }));
    live = deps.live?.(cid, sc.title, () => ctl.abort());
    // The access mode is capped again here: whatever the stored value says, unattended runs never get "full".
    const access = target.ownTools ? "readonly" : capAccess(sc.access);

    // Approvals: shown to the user (floating card and, when the chat is open, in the chat), never answered automatically.
    // After the timeout the run is stopped as "needs attention".
    const approve = createApprover({
      chatId: cid,
      signal: ctl.signal,
      who: sc.title,
      beginApproval: deps.beginApproval,
      ask: (req) => req.kind === "command",
      present: (req, answer) => {
        const inChat = live?.approval(req, answer);
        const card = deps.askUser({ scheduleId: sc.id, chatId: cid, title: sc.title, command: req.kind === "command" ? req.command : "" }, answer);
        return () => {
          inChat?.();
          card();
        };
      },
      timeoutMs: deps.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      onTimeout: () => {
        attention = true;
        ctl.abort();
      },
    });

    const { history } = await appendUserMessage(deps, { chatId: cid, root: projectRoot, parts: [{ type: "text", text: sc.prompt }], ignoreCheckpointErrors: true });
    live?.message("user");
    await runChatCore(
      {
        chatId: cid,
        root: projectRoot,
        history,
        access,
        target: async () => ({ adapter: target.adapter, providerId: sc.providerId, model: sc.model, supportsTools: target.supportsTools, reasoning: deps.reasoning(), computerUse: false, nativeInstructions: target.nativeInstructions }),
        allowlist: deps.allowlist(),
        signal: ctl.signal,
        stop: () => ctl.abort(),
        approve,
        source: "scheduled",
      },
      deps,
      {
        onReview: (r) => (review = r),
        onNotice: (text) => void deps.addMessage(cid, msgText(deps.note("failed", text), "assistant")).catch(() => {}),
        onText: (d) => live?.text(d),
        onToolResult: (r) => live?.toolResult(r),
        onActivity: (a) => live?.activities(a),
        onRetry: (info) => live?.retry(deps.retryNotice?.(info) ?? ""),
        onMessage: (m) => live?.message(m.role),
      },
    );
    if (attention) {
      await deps.addMessage(cid, msgText(deps.note("attention"), "assistant")).catch(() => {});
      return { status: "attention", chatId: cid };
    }
    if (ctl.signal.aborted) {
      await deps.addMessage(cid, msgText(deps.note("stopped"), "assistant")).catch(() => {});
      return { status: "stopped", chatId: cid };
    }
    succeeded = true;
    return { status: "success", chatId: cid };
  } catch (e) {
    // The loop ends with an abort error when it was stopped mid-step; the chat still says why the run ended.
    if (attention || ctl.signal.aborted) {
      if (chatId !== null && release) await deps.addMessage(chatId, msgText(deps.note(attention ? "attention" : "stopped"), "assistant")).catch(() => {});
      return { status: attention ? "attention" : "stopped", chatId };
    }
    const message = (await reportRunFailure(e, { providerId: sc.providerId, signal: ctl.signal }, deps)) ?? "";
    return await fail(message);
  } finally {
    outer.removeEventListener("abort", stopOuter);
    // Like a chat: the copy is removed when nothing was changed in it, otherwise it stays for the review panel.
    try { await finishReviewCopy(deps, review); } finally {
      if (release && chatId) await updateQueue(chatId, q => ({ ...q, interrupted: !succeeded, paused: succeeded ? q.paused : true })).catch(() => {});
      live?.end(); release?.();
    }
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
