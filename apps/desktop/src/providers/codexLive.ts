// Codex app-server as a live session: one `codex app-server` process with its loaded thread per chat (kept by
// `liveSessions`), so the next turn is a `turn/start` on the thread that is already loaded: no new process, no
// re-initialize, no `thread/resume`. Pure of Tauri (the process comes from `open`), unit-tested in
// tests/codexLiveSession.test.mjs.
//
// What needs a new process (the launch signature): only what a turn cannot set. `turn/start` takes model, effort, cwd,
// approval policy and sandbox policy "for this turn and subsequent turns" (codex-cli 0.160 schema, TurnStartParams), so
// changing them keeps the process; going back to the CLI's default model or effort cannot be expressed as an override,
// and a goal's effort travels as thread config (`thread/start|resume`), so those start a fresh process that resumes the
// thread. The folder is part of the session key.
//
// Children that outlive the parent turn: the turn still stays open while they run (bounded by CHILD_WAIT_MS), because the
// chat card of the turn is where their updates are shown and Stop must reach them. It ends early when a follow-up message
// waits: the children keep running in the live process, the session reports `backgroundWork()` (so it is pinned instead of
// released as idle), their updates are folded into the session and shown by the next turn. A turn ending at the root's
// turn/completed with updates sent nowhere was considered and rejected: after the turn returned there is no chat message to
// update.
import {
  AppServerUnavailable,
  createAppServerSession,
  type AppServerSession,
  type Connection,
} from "./codexAppServer.ts";
import type { TurnHandlers, TurnParams, TurnResult } from "./codexAppServer.ts";
import { liveSessions, sessionKey, type ManagedSession } from "./sessionManager.ts";

type LiveSession = AppServerSession & ManagedSession;

export function liveSignature(executable: string, p: TurnParams) {
  return JSON.stringify({
    executable,
    defaultModel: !p.model,
    defaultEffort: !p.reasoning,
    goalEffort: p.goal ? (p.reasoning ?? "") : "",
  });
}

export type LiveTurnOptions = {
  /** Starts a `codex app-server` process. */
  open(): Promise<Connection>;
  executable: string;
  providerId: string;
  /** Without a chat there is nothing to keep the session for: the process serves this turn only. */
  chatId?: number;
  cwd?: string;
  params: TurnParams;
  handlers: TurnHandlers;
  /** The native thread is known (also when the turn is then stopped or fails). */
  onThread?(threadId: string): void;
  /** For tests: the session manager to use (default: the app's `liveSessions`). */
  sessions?: Pick<typeof liveSessions, "acquire">;
};

/**
 * One Codex turn on the chat's live app-server session. Throws `AppServerUnavailable` only when nothing was accepted
 * (the caller may fall back to `exec`); a reused process that turns out to be dead is replaced once, by a fresh process
 * that resumes the thread.
 */
export async function codexLiveTurn(o: LiveTurnOptions): Promise<TurnResult> {
  const run = async (s: LiveSession) => {
    try {
      return await s.turn(o.params, o.handlers);
    } finally {
      if (s.threadId) o.onThread?.(s.threadId);
    }
  };
  if (o.chatId == null) {
    const s = createAppServerSession(await o.open());
    try {
      return await run(s);
    } finally {
      await s.release();
    }
  }
  const sessions = o.sessions ?? liveSessions;
  const key = sessionKey({ providerId: o.providerId, chatId: o.chatId, cwd: o.cwd });
  const signature = liveSignature(o.executable, o.params);
  for (let attempt = 0; ; attempt++) {
    const lease = await sessions.acquire<LiveSession>(key, signature, async () =>
      createAppServerSession(await o.open()),
    );
    // The live thread is not the one this turn continues (history edited, chat branched, or a fresh thread wanted).
    if (lease.reused && lease.session.threadId !== o.params.session) {
      lease.done({ broken: true });
      if (attempt < 2) continue;
      throw new Error("Could not open a Codex session for this chat");
    }
    try {
      const r = await run(lease.session);
      lease.done({ broken: !lease.session.alive() });
      return r;
    } catch (e) {
      lease.done({ broken: !lease.session.alive() });
      // The kept process died between turns after the liveness check: once more on a fresh one (`thread/resume`).
      if (e instanceof AppServerUnavailable && lease.reused && attempt === 0) continue;
      throw e;
    }
  }
}
