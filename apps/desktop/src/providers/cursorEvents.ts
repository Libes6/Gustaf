import type { Activity } from "./activities";

// Pure mapping of the Cursor SDK sidecar's events (sidecar/cursor-agent.mjs) to cards and a turn result; node tests
// cover it (tests/cursorLifecycle.test.mjs), so only `import type` is allowed here.

/** A `tool` event of the sidecar: an SDK `tool_call` message (status running | completed | error). */
export type CursorToolEvent = {
  id?: string;
  name: string;
  status?: string;
  args?: Record<string, unknown>;
  output?: string;
};

/** SDK tool status to a card status; anything the SDK may add later reads as `unknown`, never as success. */
export function cursorToolStatus(status: unknown): Activity["status"] {
  switch (status) {
    case "running":
      return "running";
    case "completed":
    case "success":
    case "finished":
      return "success";
    case "error":
    case "failed":
      return "error";
    default:
      return "unknown";
  }
}

export function cursorActivity(e: CursorToolEvent): Activity {
  return {
    type: "activity",
    id: e.id ?? `${e.name}:${JSON.stringify(e.args ?? {})}`,
    name: e.name,
    args: e.args ?? {},
    status: cursorToolStatus(e.status),
    output: e.output,
  };
}

/** Cards of a turn that is over: a card still `running` was never closed by the SDK, so its outcome is unknown. */
export const settleActivities = (acts: Iterable<Activity>): Activity[] =>
  [...acts].map((a) => (a.status === "running" ? { ...a, status: "unknown" as const } : a));

/**
 * Why a run the app did not stop failed, or "" when it finished. `status`: the `done` event's run status (finished |
 * error | cancelled; absent when the sidecar ended without one); `error`: an `error` event or the run's error message.
 */
export function cursorRunFailure(o: { status?: string; error?: string; runError?: string }): string {
  if (o.error) return o.error;
  switch (o.status) {
    case "finished":
      return "";
    case "error":
      return o.runError || "Cursor reported that the run failed.";
    case "cancelled":
      return o.runError || "Cursor cancelled the run before it finished.";
    case undefined:
      return "The Cursor sidecar ended without a result.";
    default:
      return o.runError || `Cursor ended the run with status ${o.status}.`;
  }
}
