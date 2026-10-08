import { followUpPump } from "./lifecycle";
import type { TurnInput } from "./types";

/**
 * A turn of a per-turn agent (one process per turn: cursor-agent CLI, `codex exec`, the Cursor SDK sidecar) that a
 * follow-up can restart, T3 Code's `restart_active`. When a clarification is waiting, `signal` aborts: the adapter stops
 * its process gracefully and returns what the turn produced as a normal `TurnOutput` (text so far, cards, session id).
 * The message is never taken here: it stays queued, and the agent loop, which reads clarifications after a turn without
 * tool calls, sends it as the next turn resuming the same session. Stop (the run's own signal) aborts `signal` too;
 * `stopped()` and `restarted()` tell the two apart. `ended()`: the turn already reached its terminal event, so a restart
 * gains nothing (the loop takes the message right after it). `enabled` false: follow-ups simply wait for the turn.
 */
export function restartableTurn(
  t: Pick<TurnInput, "signal" | "followUp">,
  o: { enabled?: boolean; ended?: () => boolean } = {},
) {
  const ctl = new AbortController();
  let restart = false;
  const stop = () => ctl.abort();
  if (t.signal.aborted) ctl.abort();
  else t.signal.addEventListener("abort", stop, { once: true });
  const closePump =
    o.enabled === false
      ? async () => {}
      : followUpPump(t.followUp, async () => {
          if (!ctl.signal.aborted && !o.ended?.()) {
            restart = true;
            ctl.abort();
          }
          return false;
        });
  return {
    signal: ctl.signal,
    stopped: () => t.signal.aborted,
    restarted: () => restart && !t.signal.aborted,
    /** Awaited before the turn returns, so no delivery is in flight when the loop reads the queue. */
    async close() {
      t.signal.removeEventListener("abort", stop);
      await closePump();
    },
  };
}
