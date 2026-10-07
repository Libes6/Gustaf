// What Enter does with a message sent while the agent is running in the same chat (pure: node tests cover it).
//   "queue" - the message becomes the next request and runs after the current one ends (FIFO, one run per chat).
//   "steer" - the message is handed to the running turn as a clarification (only providers that take one).
import type { PendingMessage, QueueState } from "./chatQueue.ts";

export type FollowUpAction = "queue" | "steer";

export const DEFAULT_FOLLOW_UP: FollowUpAction = "queue";

/** A saved value that is not one of the two actions falls back to the default. */
export const normalizeFollowUp = (v: unknown): FollowUpAction => (v === "steer" ? "steer" : DEFAULT_FOLLOW_UP);

/**
 * The action for this send. `opposite` is the other-action shortcut. A provider without steering can only queue, whatever
 * the setting or the shortcut says.
 */
export function resolveFollowUp(mode: FollowUpAction, opposite: boolean, canSteer: boolean): FollowUpAction {
  if (!canSteer) return "queue";
  return opposite ? (mode === "steer" ? "queue" : "steer") : mode;
}

/** What the composer hint shows while a run is going. */
export type FollowUpPlan = { action: FollowUpAction; other: FollowUpAction | null; canSteer: boolean };
export function followUpPlan(mode: FollowUpAction, canSteer: boolean): FollowUpPlan {
  const action = resolveFollowUp(mode, false, canSteer);
  return { action, other: canSteer ? (action === "steer" ? "queue" : "steer") : null, canSteer };
}

/** Preserve FIFO: only the clarifications at the head of the queue may join the running turn; the first normal message stops the scan. */
export function leadingClarifications(items: readonly PendingMessage[]): PendingMessage[] {
  const out: PendingMessage[] = [];
  for (const item of items) { if (!item.clarify) break; out.push(item); }
  return out;
}

/** The queued message to start next, or null. Never while the chat has a run (or a pending start), so a chat never has two runs. */
export function nextQueued(q: QueueState | undefined, s: { running: boolean; coordinatorBusy: boolean; draining: boolean; aborting: boolean; loaded: boolean }): PendingMessage | null {
  if (!q || q.paused || s.running || s.coordinatorBusy || s.draining || s.aborting || !s.loaded) return null;
  return q.items[0] ?? null;
}
