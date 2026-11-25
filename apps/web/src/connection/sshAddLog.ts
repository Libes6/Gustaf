import type { DesktopSshEnsureProgress, DesktopSshEnsureProgressStep } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/** The desktop reports the first twelve; the renderer adds the two requests it makes itself. */
export type SshAddLogStep = DesktopSshEnsureProgressStep | "descriptor" | "session";

export interface SshAddLogEntry {
  readonly step: SshAddLogStep;
  readonly status: DesktopSshEnsureProgress["status"];
  readonly detail?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
}

export interface SshAddLogEvent {
  readonly step: SshAddLogStep;
  readonly status: DesktopSshEnsureProgress["status"];
  readonly detail?: string;
  readonly at: number;
}

/** A step that runs again, such as connect after a password, is a new entry, not a rewrite. */
export function applySshAddLogEvent(
  entries: ReadonlyArray<SshAddLogEntry>,
  event: SshAddLogEvent,
): ReadonlyArray<SshAddLogEntry> {
  const index = entries.findLastIndex((entry) => entry.step === event.step);
  const current = index === -1 ? undefined : entries[index];
  const detail = event.detail === undefined ? {} : { detail: event.detail };
  if (event.status === "running") {
    if (current?.status === "running") {
      return entries.with(index, { ...current, ...detail });
    }
    return [...entries, { step: event.step, status: "running", ...detail, startedAt: event.at }];
  }
  if (current === undefined) {
    return [
      ...entries,
      {
        step: event.step,
        status: event.status,
        ...detail,
        startedAt: event.at,
        endedAt: event.at,
      },
    ];
  }
  // A failure can land on a step that had just finished; a late "done" cannot undo one.
  if (current.status !== "running" && event.status === "done") return entries;
  return entries.with(index, {
    ...current,
    status: event.status,
    ...(event.detail === undefined ? {} : { detail: event.detail }),
    endedAt: current.endedAt ?? event.at,
  });
}

export function sshAddLogElapsedMs(entry: SshAddLogEntry, now: number): number {
  return Math.max(0, (entry.endedAt ?? now) - entry.startedAt);
}

/** Plain English lines for a bug report: the step id is stable across languages. */
export function formatSshAddLog(entries: ReadonlyArray<SshAddLogEntry>): string {
  const origin = entries[0]?.startedAt ?? 0;
  return entries
    .map((entry) => {
      const offset = ((entry.startedAt - origin) / 1000).toFixed(1);
      const took =
        entry.endedAt === undefined
          ? ""
          : ` (${((entry.endedAt - entry.startedAt) / 1000).toFixed(1)}s)`;
      const detail = entry.detail === undefined ? "" : ` - ${entry.detail.replaceAll("\n", " | ")}`;
      return `+${offset}s ${entry.step} ${entry.status}${took}${detail}`;
    })
    .join("\n");
}

const EMPTY_LOG: ReadonlyArray<SshAddLogEntry> = [];
const logs = new Map<string, ReadonlyArray<SshAddLogEntry>>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** Starts a fresh log for a target; a retry replaces the previous attempt's. */
export function resetSshAddLog(key: string): void {
  logs.set(key, EMPTY_LOG);
  notify();
}

export function recordSshAddLogEvent(key: string, event: SshAddLogEvent): void {
  logs.set(key, applySshAddLogEvent(logs.get(key) ?? EMPTY_LOG, event));
  notify();
}

/** Records a request the renderer makes itself as one step of the log. */
export async function trackSshAddLogStep<A>(
  key: string,
  step: SshAddLogStep,
  run: () => Promise<A>,
): Promise<A> {
  recordSshAddLogEvent(key, { step, status: "running", at: Date.now() });
  try {
    const result = await run();
    recordSshAddLogEvent(key, { step, status: "done", at: Date.now() });
    return result;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    recordSshAddLogEvent(key, {
      step,
      status: "failed",
      detail: message.slice(0, 300),
      at: Date.now(),
    });
    throw cause;
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getSshAddLog = (key: string): ReadonlyArray<SshAddLogEntry> =>
  logs.get(key) ?? EMPTY_LOG;

export function useSshAddLog(key: string | null): ReadonlyArray<SshAddLogEntry> {
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY_LOG : getSshAddLog(key)),
    () => EMPTY_LOG,
  );
}
