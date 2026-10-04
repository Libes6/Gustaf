import { useMemo, useSyncExternalStore } from "react";
import type { Part, SubagentInfo } from "../providers/types";

// Subagents that a CLI agent (Codex, Claude Code) runs inside its own process, mirrored read-only in the agents panel.
// They are fed from the same activity stream as the chat's "Subagents" card (providers/activities.ts), live while the
// chat run is active and kept for this session only (nothing is written to SQLite). Stopping one stops the whole CLI run.

type Activity = Extract<Part, { type: "activity" }>;
export type CliAgentState = SubagentInfo["state"] | "ended";

export type CliAgent = {
  key: string;
  chatId: number;
  root: string;
  provider: SubagentInfo["provider"];
  agentId: string;
  /** Empty when the CLI gave the agent no name. */
  title: string;
  role?: string;
  state: CliAgentState;
  prompt?: string;
  result?: string;
  /** Full report, when there is one. */
  output?: string;
  toolUses: number;
  /** Total tokens (Codex rollout scan only). */
  tokens?: number;
  step?: string;
  startedAt: number;
  endedAt?: number;
  /** Stops the whole CLI run of the chat (the CLI does not expose its subagents individually). */
  stop?: () => void;
};

export const isCliAgentActive = (a: Pick<CliAgent, "state">) => a.state === "running" || a.state === "waiting";

let entries: CliAgent[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

/** Pure: the entry after one subagent activity (the activity already carries the merged state of the agent). */
export function cliAgentFrom(a: Activity, ctx: { chatId: number; root: string; stop?: () => void }, prev: CliAgent | undefined, now: number): CliAgent | null {
  const s = a.subagent;
  if (!s) return null;
  const state: CliAgentState = s.state;
  return {
    key: `${ctx.chatId}:${a.id}`,
    chatId: ctx.chatId,
    root: ctx.root,
    provider: s.provider,
    agentId: s.agentId,
    title: s.title,
    ...(s.role ? { role: s.role } : {}),
    state,
    ...(s.prompt ? { prompt: s.prompt } : {}),
    ...(s.result ? { result: s.result } : {}),
    ...(a.output ? { output: a.output } : {}),
    toolUses: s.toolUses ?? 0,
    ...(s.step ? { step: s.step } : {}),
    ...(s.tokens ? { tokens: s.tokens } : {}),
    // Times read from a rollout file are the real ones; otherwise the moment the event arrived.
    startedAt: s.startedAt ?? prev?.startedAt ?? now,
    ...(!isCliAgentActive({ state }) ? { endedAt: s.endedAt ?? prev?.endedAt ?? now } : {}),
    ...(ctx.stop ? { stop: ctx.stop } : {}),
  };
}

const same = (a: CliAgent, b: CliAgent) => (Object.keys(b) as (keyof CliAgent)[]).every((k) => a[k] === b[k]) && Object.keys(a).length === Object.keys(b).length;

/** Feeds the (cumulative) activity list of a running chat turn; entries are created or updated in place. */
export function trackCliAgents(ctx: { chatId: number; root: string | null; stop?: () => void }, activities: readonly Activity[], now = Date.now()) {
  if (!ctx.root) return;
  const root = ctx.root;
  let next = entries;
  for (const a of activities) {
    if (!a.subagent) continue;
    const key = `${ctx.chatId}:${a.id}`;
    const prev = next.find((e) => e.key === key) ?? next.find((e) => e.chatId === ctx.chatId && e.provider === a.subagent!.provider && !!a.subagent!.agentId && e.agentId === a.subagent!.agentId);
    const entry = cliAgentFrom(a, { chatId: ctx.chatId, root, stop: ctx.stop }, prev, now);
    if (!entry || (prev && same(prev, entry))) continue;
    next = prev ? next.map((e) => (e === prev ? entry : e)) : [entry, ...next];
    next = next.filter((e) => e === entry || e.chatId !== entry.chatId || e.provider !== entry.provider || !entry.agentId || e.agentId !== entry.agentId);
  }
  if (next !== entries) {
    entries = next;
    emit();
  }
}

/**
 * The chat run ended: whatever was still running is over. `stopped`: the user stopped the run, so those agents are
 * "stopped" (as Codex reports an interrupted turn); otherwise "ended" (the CLI never reported their result).
 */
export function finishCliAgents(chatId: number, now = Date.now(), stopped = false) {
  if (!entries.some((e) => e.chatId === chatId && isCliAgentActive(e))) return;
  entries = entries.map((e) => {
    if (e.chatId !== chatId) return e;
    const { stop: _stop, ...rest } = e;
    return isCliAgentActive(e) ? { ...rest, state: stopped ? ("stopped" as const) : ("ended" as const), endedAt: now } : rest;
  });
  emit();
}

export function clearFinishedCliAgents(root?: string) {
  const next = entries.filter((e) => isCliAgentActive(e) || (root !== undefined && e.root !== root));
  if (next.length === entries.length) return;
  entries = next;
  emit();
}

export const getCliAgents = () => entries;
/** Test helper. */
export function resetCliAgents() {
  entries = [];
  emit();
}

/** The mirrored subagents of one project folder (newest first). */
export function useCliAgents(root?: string | null): CliAgent[] {
  const all = useSyncExternalStore(subscribe, () => entries);
  return useMemo(() => (root ? all.filter((e) => e.root === root) : all), [all, root]);
}
