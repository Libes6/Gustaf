import { runAgent, type ApprovalAnswer, type ApprovalRequest, type RunOptions } from "../agent/agent";
import type { Adapter, LimitWindow, Msg, Part, Reasoning, TokenUsage } from "../providers/types";

// The part of "run the agent in a chat" that interactive sends (lib/useChatRun.ts) and scheduled runs
// (lib/scheduledRun.ts) share, without React or any app state: store the user message with its checkpoint, make the
// shadow copy of the project, run the agent loop, persist every message and count its tokens, keep the live
// activities so an interrupted run still leaves its tool cards, record the provider result and finish the copy.
// Everything that differs (streaming into React state or into the live-run store, how an approval is shown, limits
// of unattended runs, error text) is injected through `ChatRunDeps` and `ChatRunUi`. Tested in tests/chatRunCore.test.mjs.

export type ReviewCopy = { id: string; workspace: string; root?: string; /** Directories symlinked into the copy; never applied. */ linked?: string[] };
export type RunTarget = {
  adapter: Adapter;
  providerId: string;
  model: string;
  supportsTools?: boolean;
  reasoning?: Reasoning;
  computerUse: boolean;
  nativeInstructions?: string[];
};
type Activity = Extract<Part, { type: "activity" }>;
export type StoredFields = { id: number; chat_id: number; created_at: number };

export type ChatRunDeps = {
  addMessage(chatId: number, msg: Msg): Promise<number>;
  /** Snapshot of the project taken before a user message (for rewind and undo). */
  checkpoint?(root: string): Promise<string | undefined>;
  /** Shadow copy for a writable project; `review: null` runs in the project folder. `error` is shown as a notice. */
  prepareReview?(root: string, approve: (command: string) => Promise<boolean>): Promise<{ review: ReviewCopy | null; error?: string }>;
  /** Removes the copy when nothing changed in it, otherwise it stays for the review panel. */
  finishReview?(id: string): Promise<void>;
  recordUsage(providerId: string, model: string, usage?: TokenUsage): void;
  bumpUsage(providerId: string): void;
  recordResult(providerId: string, error?: string): void;
  onLimits?(providerId: string, windows: LimitWindow[]): void;
  /** For tests: the agent loop. */
  runAgent?: (o: RunOptions) => Promise<void>;
};

/** What the UI wants to see of a run (all optional; an unattended run without a visible chat passes only a few). */
export type ChatRunUi = {
  /** The shadow copy exists: the caller tracks it to finish it, also when the run fails later. */
  onReview?(review: ReviewCopy): void;
  /** The setup of the copy declined or failed (text for the user). */
  onNotice?(text: string): void;
  /** History is final and the model is about to be chosen (for retry bookkeeping and the "thinking" state). */
  onReady?(history: Msg[]): void;
  onText?(delta: string): void;
  onToolResult?(result: Extract<Part, { type: "tool_result" }>): void;
  /** The complete list of running/finished activities of the current step. */
  onActivity?(activities: Activity[]): void;
  onRetry?: RunOptions["onRetry"];
  /** A message is about to be stored (retry bookkeeping). */
  onAccepted?(msg: Msg): void;
  /** A message was stored. Also called for the partial message of an interrupted run. */
  onMessage?(msg: Msg, id: number): void;
};

export type ChatRunInput = {
  chatId: number;
  root: string | null;
  /** Final history for the model (already includes the new user message). */
  history: Msg[];
  /** A retry: the history comes from the interrupted run, response ids are kept. */
  retry?: boolean;
  access: RunOptions["access"];
  /** An existing copy to keep working in (retry); `undefined` makes one when the access mode and project allow it. */
  review?: ReviewCopy | null;
  /** Chooses the provider and model; called after the copy exists (the interactive path rotates accounts here). */
  target(): Promise<RunTarget>;
  allowlist: string[];
  signal: AbortSignal;
  approve: RunOptions["approve"];
  subagents?: RunOptions["subagents"];
  source?: RunOptions["source"];
};

/** Stores a new user message, with the checkpoint of the project taken just before it. */
export async function appendUserMessage(
  deps: Pick<ChatRunDeps, "addMessage" | "checkpoint">,
  o: { chatId: number; root: string | null; parts: Part[]; prior?: Msg[]; /** An unattended run goes on without a checkpoint; a user's send reports the failure. */ ignoreCheckpointErrors?: boolean },
): Promise<{ msg: Msg; stored: Msg & StoredFields; history: Msg[] }> {
  const cp = o.root && deps.checkpoint ? await (o.ignoreCheckpointErrors ? deps.checkpoint(o.root).catch(() => undefined) : deps.checkpoint(o.root)) : undefined;
  const msg: Msg = { role: "user", parts: o.parts, meta: { checkpoint: cp } };
  const id = await deps.addMessage(o.chatId, msg);
  const stored = { ...msg, id, chat_id: o.chatId, created_at: Date.now() };
  return { msg, stored, history: [...(o.prior ?? []), stored] };
}

/** Runs the agent once. Throws on failure (after storing the partial activities); use `reportRunFailure` in the catch. */
export async function runChatCore(i: ChatRunInput, deps: ChatRunDeps, ui: ChatRunUi = {}): Promise<{ review: ReviewCopy | null; target: RunTarget }> {
  let review = i.review;
  if (review === undefined) {
    review = null;
    if (i.root && i.access !== "readonly" && deps.prepareReview) {
      const made = await deps.prepareReview(i.root, (command) => i.approve({ kind: "command", command }).then(Boolean));
      review = made.review;
      if (review) ui.onReview?.(review);
      if (made.error) ui.onNotice?.(made.error);
    }
  } else if (review) ui.onReview?.(review);
  const workspace = review?.workspace ?? i.root;
  // A copy starts from the files, not from the provider's stored conversation.
  const history = review && !i.retry ? i.history.map((m) => ({ ...m, meta: m.meta ? { ...m.meta, responseId: undefined } : undefined })) : i.history;
  ui.onReady?.(history);
  let target: RunTarget | undefined;
  let activities: Activity[] = [];
  try {
    const tg = (target = await i.target());
    deps.bumpUsage(tg.providerId);
    await (deps.runAgent ?? runAgent)({
      root: workspace,
      chatId: i.chatId,
      reviewMode: !!review,
      reviewLinked: review?.linked,
      supportsTools: tg.supportsTools,
      history,
      adapter: tg.adapter,
      providerId: tg.providerId,
      model: tg.model,
      reasoning: tg.reasoning,
      access: i.access,
      computerUse: tg.computerUse,
      nativeInstructions: tg.nativeInstructions,
      allowlist: i.allowlist,
      signal: i.signal,
      source: i.source,
      subagents: i.subagents,
      onLimits: (windows) => deps.onLimits?.(tg.providerId, windows),
      onRetry: ui.onRetry,
      onText: (d) => ui.onText?.(d),
      onToolResult: (r) => ui.onToolResult?.(r),
      onActivity: (a) => {
        activities = [...activities.filter((p) => p.id !== a.id), a];
        ui.onActivity?.(activities);
      },
      onMessage: async (m) => {
        // After a stop only the results of tools that already ran are kept, so every stored call has its result.
        if (i.signal.aborted && !m.parts.some((p) => p.type === "tool_result")) return;
        deps.recordUsage(tg.providerId, tg.model, m.meta?.usage);
        ui.onAccepted?.(m);
        const id = await deps.addMessage(i.chatId, m);
        activities = [];
        ui.onMessage?.(m, id);
      },
      approve: i.approve,
    });
    if (!i.signal.aborted) deps.recordResult(tg.providerId);
    return { review: review ?? null, target: tg };
  } catch (e) {
    // The interrupted step's tool cards are kept (still-running ones as "unknown") so the chat shows what happened.
    if (target && activities.length) {
      const partial: Msg = { role: "assistant", parts: activities.map((a) => (a.status === "running" ? { ...a, status: "unknown" } : a)), meta: { provider: target.providerId, model: target.model } };
      ui.onAccepted?.(partial);
      const id = await deps.addMessage(i.chatId, partial).catch(() => null);
      if (id !== null) ui.onMessage?.(partial, id);
    }
    throw e;
  }
}

/**
 * The failure of a run: `null` when the user stopped it (nothing to report), else the text for the user. `decorate`
 * may extend it (the Cursor quota note). The provider's health is recorded here.
 */
export async function reportRunFailure(e: unknown, o: { providerId: string; signal: AbortSignal; decorate?: (message: string) => Promise<string> | string }, deps: Pick<ChatRunDeps, "recordResult">): Promise<string | null> {
  if (o.signal.aborted) return null;
  let message = String((e as Error)?.message ?? e);
  if (o.decorate) message += await o.decorate(message);
  deps.recordResult(o.providerId, message);
  return message;
}

/** Ends the shadow copy; returns the error text when that failed. */
export async function finishReviewCopy(deps: Pick<ChatRunDeps, "finishReview">, review: ReviewCopy | null): Promise<string | undefined> {
  if (!review || !deps.finishReview) return undefined;
  return deps.finishReview(review.id).then(() => undefined, (e) => String(e));
}

export type ApproverOptions = {
  chatId: number;
  signal: AbortSignal;
  who: string | ((req: ApprovalRequest) => string);
  /** Sidebar badge on the chat (and a notification while the app is unfocused) until the request is answered. */
  beginApproval(chatId: number, who: string): () => void;
  /** Shows the request; the UI calls `answer` once. Returns a function that removes the request again. */
  present(req: ApprovalRequest, answer: (ok: boolean, always?: boolean) => void): () => void;
  /** Requests for which this is false are denied without asking (an unattended run only asks about commands). */
  ask?(req: ApprovalRequest): boolean;
  onAnswer?(req: ApprovalRequest, ok: boolean, always?: boolean): void;
  /** After this long without an answer `onTimeout` is called (the unattended run aborts itself). */
  timeoutMs?: number;
  onTimeout?(): void;
};

/** The approval flow shared by chats and scheduled runs: badge, one answer at most, denied when the run is aborted. */
export function createApprover(o: ApproverOptions): (req: ApprovalRequest) => Promise<ApprovalAnswer> {
  return (req) =>
    new Promise<ApprovalAnswer>((resolve) => {
      if (o.signal.aborted || (o.ask && !o.ask(req))) return resolve(false);
      const ended = o.beginApproval(o.chatId, typeof o.who === "function" ? o.who(req) : o.who);
      let withdraw = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      let done = false;
      const finish = (ok: boolean, always?: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        o.signal.removeEventListener("abort", deny);
        withdraw();
        ended();
        o.onAnswer?.(req, ok, always);
        resolve(ok && always && req.kind === "computer" ? "task" : ok);
      };
      const deny = () => finish(false);
      o.signal.addEventListener("abort", deny, { once: true });
      withdraw = o.present(req, finish);
      if (done) withdraw();
      if (o.timeoutMs !== undefined) timer = setTimeout(() => o.onTimeout?.(), o.timeoutMs);
      if (done) clearTimeout(timer);
    });
}
