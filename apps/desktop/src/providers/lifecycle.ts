import type { CliId, Msg, ProviderConfig, TurnOutput } from "./types";

// Agent lifecycle shared by every CLI-backed provider: how a session is connected, how a follow-up reaches a running
// turn and how a turn ends. Modelled on T3 Code's provider runtime (MIT, github.com/pingdotgg/t3code,
// apps/server/src/orchestration-v2): behaviour is chosen from capability data, never from the provider's name.

/**
 * How a message sent while a turn runs reaches the agent.
 * - `steer`: written into the live turn (Claude stream-json input, Codex `turn/steer`).
 * - `restart`: the turn is interrupted softly, keeps what it produced, and the next turn starts with the message.
 * - `queue`: the message waits until the turn ends.
 */
export type FollowUpMode = "steer" | "restart" | "queue";

export type Capabilities = {
  /** One agent process serves many turns of a chat (kept by `sessionManager`), instead of one process per turn. */
  liveSession: boolean;
  followUp: FollowUpMode;
  /** Stop asks the agent to end the turn (native interrupt) before the process tree is killed. */
  softInterrupt: boolean;
};

const CLI: Record<CliId, Capabilities> = {
  claude: { liveSession: true, followUp: "steer", softInterrupt: true },
  codex: { liveSession: true, followUp: "steer", softInterrupt: true },
  "cursor-agent": { liveSession: false, followUp: "restart", softInterrupt: true },
};

/** Capabilities of a provider; `codexExec`: Codex runs over `codex exec` (no app-server), one process per turn. */
export function capabilitiesOf(
  cfg: Pick<ProviderConfig, "kind" | "cli">,
  o: { codexExec?: boolean } = {},
): Capabilities {
  if (cfg.cli === "codex" && o.codexExec) return { liveSession: false, followUp: "restart", softInterrupt: true };
  if (cfg.cli) return CLI[cfg.cli];
  if (cfg.kind === "cursor") return { liveSession: false, followUp: "restart", softInterrupt: true };
  // ACP has no steer: a follow-up cancels the running prompt softly (`session/cancel`) and the live session takes the message next.
  if (cfg.kind === "antigravity") return { liveSession: true, followUp: "restart", softInterrupt: true };
  // API providers: the app's own loop reads clarifications between steps.
  return { liveSession: false, followUp: "steer", softInterrupt: false };
}

/**
 * Follow-ups for the running turn (see `TurnInput.followUp`). `onWake` fires when a clarification may be waiting;
 * `take` removes the clarifications at the head of the chat queue (FIFO is kept: a normal message stops the scan);
 * `delivered` stores messages the adapter handed to the live agent, so they show in the chat where they were sent.
 */
export type FollowUpChannel = {
  onWake(cb: () => void): () => void;
  take(): Promise<Msg[]>;
  delivered(msgs: Msg[]): Promise<void>;
};

/** How a turn ended (T3 `turn.terminal`). `broken`: the native thread/session must not be resumed as is. */
export type TurnTerminal = {
  status: "completed" | "interrupted" | "failed";
  disposition: "reusable" | "broken";
};

/** The error a stopped turn throws: an `AbortError` that carries what the turn produced before the stop. */
export type InterruptedError = DOMException & { partial?: TurnOutput };

export function interrupted(partial?: TurnOutput): InterruptedError {
  const e = new DOMException("Aborted", "AbortError") as InterruptedError;
  if (partial) e.partial = partial;
  return e;
}

export const partialOf = (e: unknown): TurnOutput | undefined =>
  e instanceof DOMException && e.name === "AbortError" ? (e as InterruptedError).partial : undefined;

/**
 * Serialises follow-up delivery for one turn: a wake while a delivery is in flight runs once more afterwards, so a
 * message is never taken twice and never left behind. `deliver` returns false when the turn can no longer take it
 * (it stays in the queue and becomes the next turn). Returns `close`, which resolves once no delivery is in flight;
 * an adapter awaits it before its turn returns, so the agent loop never takes the same message a second time.
 */
export function followUpPump(ch: FollowUpChannel | undefined, deliver: (msgs: Msg[]) => Promise<boolean>) {
  if (!ch) return async () => {};
  let busy: Promise<void> | undefined;
  let again = false;
  let closed = false;
  const pump = () => {
    if (busy) {
      again = true;
      return;
    }
    busy = run();
  };
  const run = async () => {
    try {
      do {
        again = false;
        if (closed) return;
        const msgs = await ch.take();
        if (!msgs.length) continue;
        if (await deliver(msgs)) await ch.delivered(msgs);
        else closed = true;
      } while (again && !closed);
    } catch {
      /* the message stays queued and is sent as the next turn */
    } finally {
      busy = undefined;
    }
  };
  const off = ch.onWake(pump);
  pump();
  return async () => {
    closed = true;
    off();
    await busy;
  };
}
