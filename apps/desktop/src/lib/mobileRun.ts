import type { Msg } from "../providers/types";
import { claimChat } from "./chatCoordinator";
import { loadQueue, updateQueue } from "./chatQueue";
import {
  appendUserMessage,
  createApprover,
  finishReviewCopy,
  reportRunFailure,
  runChatCore,
  type ReviewCopy,
} from "./chatRunCore";
import { effectiveHistory } from "./context";
import type { LiveRunHandle } from "./liveRuns";
import { APPROVAL_TIMEOUT_MS, capAccess } from "./scheduledPrompts";
import type { ScheduledRunDeps } from "./scheduledRun";

// A message sent from the phone (lib/mobileCommands.ts, server side in src-tauri/src/mobile_server): the same run core as an
// interactive send and a scheduled run (chatRunCore), but with the chat's whole history and the safety rules of an
// unattended run, because nobody sits at this computer: access never goes beyond "auto" (never "full"), Computer Use is
// off, no subagents, CLI agents that run their own tools only get read-only access, and an approval is never answered for
// the user: the desktop shows it and, if nobody answers in time, the run stops as "needs attention". While it runs the chat
// is live on the desktop (lib/liveRuns.ts). The call returns once the run has been accepted; the run goes on by itself.

export type MobileSendDeps = ScheduledRunDeps & {
  loadChat(chatId: number): Promise<{ projectId: number | null; workspace: boolean } | null>;
  /** The stored messages of the chat, oldest first. */
  loadHistory(chatId: number): Promise<(Msg & { id?: number })[]>;
  /** The provider and model of the desktop's current selection. */
  defaultTarget(): { providerId: string; model: string } | null;
  access(): string;
};

export type MobileSend = {
  chatId?: number;
  projectId?: number;
  title?: string;
  text: string;
  providerId?: string | null;
  model?: string | null;
};
export type SendResult =
  { ok: true; chatId: number } | { ok: false; code: "busy" | "not_found" | "bad_request" | "failed"; message: string };

/** Runs started from phones, by chat, so that Stop can reach them. */
const running = new Map<number, AbortController>();
export const stopMobileRun = (chatId: number): boolean => {
  const ctl = running.get(chatId);
  if (!ctl) return false;
  ctl.abort();
  return true;
};
export const mobileRunning = (chatId: number) => running.has(chatId);

const msgText = (text: string): Msg => ({ role: "assistant", parts: [{ type: "text", text }] });
const firstLine = (text: string) =>
  text
    .split("\n")
    .find((l) => l.trim())
    ?.trim()
    .slice(0, 60) || "New chat";
const fail = (code: Extract<SendResult, { ok: false }>["code"], message: string): SendResult => ({
  ok: false,
  code,
  message,
});

/** The model that answered last in this chat, so a phone keeps talking to the same one the desktop used. */
function lastTarget(history: Msg[]): { providerId: string; model: string } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && m.meta?.provider && m.meta.model)
      return { providerId: m.meta.provider, model: m.meta.model };
  }
  return null;
}

export async function startMobileSend(deps: MobileSendDeps, o: MobileSend): Promise<SendResult> {
  let chatId = o.chatId ?? null;
  let projectId: number | null;
  let prior: Msg[] = [];
  if (chatId !== null) {
    const chat = await deps.loadChat(chatId);
    if (!chat) return fail("not_found", "No such chat");
    if (chat.workspace) return fail("failed", "This chat runs in its own workspace; open it on the desktop");
    projectId = chat.projectId;
    prior = effectiveHistory(await deps.loadHistory(chatId));
  } else {
    if (o.projectId === undefined) return fail("bad_request", "projectId is required");
    projectId = o.projectId;
  }
  const projectRoot = deps.projectRoot(projectId);
  if (projectRoot === undefined) return fail("not_found", "The project no longer exists");

  const wanted =
    o.providerId && o.model
      ? { providerId: o.providerId, model: o.model }
      : (lastTarget(prior) ?? deps.defaultTarget());
  if (!wanted) return fail("failed", "No provider is set up on the desktop");
  const target = await deps.resolve(wanted.providerId, wanted.model);
  if ("error" in target) return fail("failed", target.error);

  if (chatId === null) chatId = await deps.createChat(projectId, o.title?.trim() || firstLine(o.text));
  const cid = chatId;
  const release = claimChat(cid);
  if (!release) return fail("busy", "This chat is busy on the desktop");

  const ctl = new AbortController();
  running.set(cid, ctl);
  void run(deps, { cid, release, ctl, projectRoot, projectId, prior, text: o.text, wanted, target });
  return { ok: true, chatId: cid };
}

async function run(
  deps: MobileSendDeps,
  r: {
    cid: number;
    release: () => void;
    ctl: AbortController;
    projectRoot: string | null;
    projectId: number | null;
    prior: Msg[];
    text: string;
    wanted: { providerId: string; model: string };
    target: Extract<Awaited<ReturnType<ScheduledRunDeps["resolve"]>>, { adapter: unknown }>;
  },
): Promise<void> {
  const { cid, ctl, wanted, target } = r;
  let attention = false;
  let succeeded = false;
  let review: ReviewCopy | null = null;
  let live: LiveRunHandle | undefined;
  const note = (kind: "failed" | "attention" | "stopped", detail?: string) =>
    deps.addMessage(cid, msgText(deps.note(kind, detail))).catch(() => {});
  try {
    await loadQueue(cid);
    await updateQueue(cid, (q) => ({ ...q, active: true }));
    deps.chatChanged?.();
    live = deps.live?.(cid, firstLine(r.text), () => ctl.abort());
    const access = target.ownTools ? "readonly" : capAccess(deps.access());
    const approve = createApprover({
      chatId: cid,
      signal: ctl.signal,
      who: "Phone",
      beginApproval: deps.beginApproval,
      ask: (req) => req.kind === "command",
      present: (req, answer) => {
        const inChat = live?.approval(req, answer);
        const card = deps.askUser(
          {
            scheduleId: `mobile:${cid}`,
            chatId: cid,
            title: firstLine(r.text),
            command: req.kind === "command" ? req.command : "",
          },
          answer,
        );
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
    const { history } = await appendUserMessage(deps, {
      chatId: cid,
      root: r.projectRoot,
      prior: r.prior,
      parts: [{ type: "text", text: r.text }],
      ignoreCheckpointErrors: true,
    });
    live?.message("user");
    await runChatCore(
      {
        chatId: cid,
        root: r.projectRoot,
        history,
        access,
        target: async () => ({
          adapter: target.adapter,
          providerId: wanted.providerId,
          model: wanted.model,
          supportsTools: target.supportsTools,
          reasoning: deps.reasoning(),
          computerUse: false,
          nativeInstructions: target.nativeInstructions,
        }),
        allowlist: deps.allowlist(),
        signal: ctl.signal,
        stop: () => ctl.abort(),
        approve,
        source: "scheduled",
      },
      deps,
      {
        onReview: (rv) => (review = rv),
        onNotice: (text) => void note("failed", text),
        onText: (d) => live?.text(d),
        onToolResult: (res) => live?.toolResult(res),
        onActivity: (a) => live?.activities(a),
        onRetry: (info) => live?.retry(deps.retryNotice?.(info) ?? ""),
        onMessage: (m) => live?.message(m.role),
      },
    );
    if (attention) await note("attention");
    else if (ctl.signal.aborted) await note("stopped");
    else succeeded = true;
  } catch (e) {
    if (attention || ctl.signal.aborted) await note(attention ? "attention" : "stopped");
    else
      await note(
        "failed",
        (await reportRunFailure(e, { providerId: wanted.providerId, signal: ctl.signal }, deps)) ?? "",
      );
  } finally {
    try {
      await finishReviewCopy(deps, review);
    } finally {
      await updateQueue(cid, (q) => ({
        ...q,
        active: false,
        interrupted: !succeeded,
        paused: succeeded ? q.paused : true,
      })).catch(() => {});
      live?.end();
      running.delete(cid);
      r.release();
      deps.chatChanged?.();
    }
  }
}
