import { codexAgents, getSetting, setSetting, type RolloutAgent, type RolloutScan } from "../lib/api";
import type { Part, SubagentInfo, SubagentState } from "./types";

// `codex exec --json` does not report the agents a multi-agent run spawns (only empty `wait` items), but Codex writes every
// thread to its own rollout file under $CODEX_HOME/sessions while it runs. During a Codex turn this module polls the Rust
// side (src-tauri/src/codex_agents.rs, `codex_agents_scan`) with the thread id from `thread.started`, turns the answer into
// `subagent` activities and hands them to the usual path (applyActivity, the chat's Subagents card, the agents column).
// Parsing is defensive: the file format belongs to Codex and may change; anything unexpected only becomes a debug note.

type Activity = Extract<Part, { type: "activity" }>;

export const ROLLOUT_SETTING = "readCodexSessions";
/** Default on: only the rollout files of threads this app started are read. */
export const rolloutEnabled = () => getSetting<boolean>(ROLLOUT_SETTING, true).catch(() => true);
export const setRolloutEnabled = (on: boolean) => setSetting(ROLLOUT_SETTING, on);

export const POLL_MS = 1000;
/** After this many scans in a row failed, polling stops for the turn. */
const MAX_ERRORS = 5;
const MAX_OUTPUT = 4000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const brief = (s: string, n: number) => clip(s.replace(/\s+/g, " ").trim(), n);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

const STATE: Record<string, SubagentState> = { starting: "running", running: "running", completed: "completed", shutdown: "completed", failed: "failed", stopped: "stopped" };

/** "/root/queue_resume" to "queue resume": the last segment of an agent path or task name, readable. */
export function humanTask(task: string): string {
  const last = task.split("/").filter(Boolean).pop() ?? "";
  return last.replace(/[_-]+/g, " ").trim();
}

/** Id of the activity of one scanned agent: stable from the spawn call to the end. */
export const rolloutActivityId = (key: string) => `codex:${key}`;

/** Pure: the `subagent` activities (in the scan's order) for one scan result; entries without a usable key are skipped. */
export function rolloutActivities(scan: RolloutScan): Activity[] {
  const out: Activity[] = [];
  for (const a of Array.isArray(scan?.agents) ? scan.agents : []) {
    const key = text(a?.key) || text(a?.threadId) || text(a?.id);
    if (!key) continue;
    const state = STATE[text(a.state)] ?? "running";
    const nickname = text(a.nickname);
    const task = text(a.taskName);
    const threadId = text(a.threadId);
    const last = text(a.lastMessage);
    const error = text(a.error);
    const report = last || (state === "failed" ? error : "");
    // The task is what the agent was asked to do; its nickname ("Pasteur") says little, so it goes to the secondary line.
    const readable = humanTask(task);
    const role = text(a.role) || (nickname && readable ? nickname : "");
    const tokens = num(a.tokens?.total);
    const info: SubagentInfo = {
      provider: "codex",
      agentId: threadId || text(a.id) || key,
      ...(text(a.agentPath) || task.startsWith("/") ? { agentPath: text(a.agentPath) || task } : {}),
      title: brief(readable || nickname || (threadId ? threadId.slice(0, 8) : ""), 60),
      action: "scan",
      state,
      ...(role ? { role } : {}),
      ...(text(a.message) ? { prompt: brief(text(a.message), 300) } : {}),
      ...(report ? { result: brief(report, 300) } : {}),
      toolUses: num(a.toolUses) ?? 0,
      ...(text(a.step) && state === "running" ? { step: brief(text(a.step), 120) } : {}),
      ...(tokens ? { tokens } : {}),
      ...(num(a.turnStartedAtMs) ? { turnStartedAt: num(a.turnStartedAtMs) } : {}),
      ...(num(a.startedAtMs) ? { startedAt: num(a.startedAtMs) } : {}),
      ...(num(a.endedAtMs) && state !== "running" ? { endedAt: num(a.endedAtMs) } : {}),
      ...(num(a.durationMs) && state !== "running" ? { durationMs: num(a.durationMs) } : {}),
    };
    out.push({
      type: "activity",
      id: rolloutActivityId(key),
      name: "subagent",
      args: { tool: "rollout", ...(threadId ? { agent: threadId } : {}) },
      status: state === "completed" ? "success" : state === "failed" ? "error" : state === "stopped" ? "unknown" : "running",
      ...(report ? { output: clip(report, MAX_OUTPUT) } : {}),
      subagent: info,
    });
  }
  return out;
}

export type RolloutTracker = {
  /** The Codex thread id of the turn is known (`thread.started`): polling starts. A second call is ignored. */
  begin(threadId: string): void;
  /**
   * Keeps back the generic activities of a `wait` that names no agent while the scan is meant to show the agents. They are
   * dropped when the scan found agents and come back as one merged card when it found none (nothing is silently lost).
   */
  hold(acts: Activity[]): void;
  /** Stops polling; with `final` one last scan runs first (the turn ended normally). Returns the cards to publish: agents still running are returned as `stopped` (the process is gone), plus the fallback card for bare waits if the scan found nothing. Safe to call twice. */
  finish(final: boolean): Promise<Activity[]>;
};

export type TrackerOptions = {
  scan?: (threadId: string, startedAt: number) => Promise<RolloutScan>;
  /** Called with each new or changed agent entry (the caller folds it into its activity map and publishes it). */
  onActivity(a: Activity): void;
  /** Debug lines for the raw CLI log (`rollout-note`, `rollout-error`, `rollout-total`). */
  onDebug?(kind: string, data: Record<string, unknown>): void;
  startedAt?: number;
  intervalMs?: number;
};

/** Polls the rollout scan of one Codex turn. Never throws into the run: scan errors are debug lines. */
export function createRolloutTracker(o: TrackerOptions): RolloutTracker {
  const scan = o.scan ?? ((id, at) => codexAgents.scan(id, at));
  const interval = o.intervalMs ?? POLL_MS;
  const startedAt = o.startedAt ?? Date.now();
  const sent = new Map<string, string>();
  const notes = new Set<string>();
  const held = new Map<string, Activity>();
  /** The latest entry of every agent seen, to settle the ones still running when the turn is over. */
  const latest = new Map<string, Activity>();
  let thread = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;
  let stopped = false;
  let errors = 0;
  let scans = 0;
  let agents = 0;
  let finished: Activity[] | null = null;

  const debug = (kind: string, data: Record<string, unknown>) => { try { o.onDebug?.(kind, data); } catch { /* debugging aid only */ } };
  const handle = (res: RolloutScan) => {
    scans++;
    for (const n of Array.isArray(res?.notes) ? res.notes : []) {
      if (typeof n === "string" && !notes.has(n)) { notes.add(n); debug("rollout-note", { note: n }); }
    }
    for (const a of rolloutActivities(res)) {
      const sig = JSON.stringify(a);
      if (sent.get(a.id) === sig) continue;
      sent.set(a.id, sig);
      latest.set(a.id, a);
      try { o.onActivity(a); } catch { /* the caller's state is its own business */ }
    }
    agents = Math.max(agents, sent.size);
  };
  const once = async () => {
    try {
      handle(await scan(thread, startedAt));
      errors = 0;
    } catch (e) {
      errors++;
      debug("rollout-error", { error: String((e as Error)?.message ?? e).slice(0, 300), consecutive: errors });
    }
  };
  const poll = () => {
    timer = undefined;
    if (stopped) return;
    inflight = once().then(() => {
      inflight = null;
      if (!stopped && errors < MAX_ERRORS) timer = setTimeout(poll, interval);
    });
  };

  return {
    begin(threadId) {
      if (thread || stopped || !threadId) return;
      thread = threadId;
      poll();
    },
    hold(acts) {
      for (const a of acts) held.set(a.id, a);
    },
    async finish(final) {
      if (finished) return finished;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inflight;
      if (final && thread) await once();
      // The Codex process is gone, so nothing it started still runs (it does not always write an end to a child's file).
      const now = Date.now();
      finished = [...latest.values()]
        .filter((a) => a.subagent && (a.subagent.state === "running" || a.subagent.state === "waiting"))
        .map((a): Activity => {
          const { step: _step, ...info } = a.subagent!;
          return { ...a, status: "unknown", subagent: { ...info, action: "scan", state: "stopped", endedAt: now } };
        });
      if (agents === 0 && held.size) {
        // The scan found nothing (no files, other Codex version): one merged generic card instead of one per wait.
        const all = [...held.values()];
        finished.push({ ...all[all.length - 1], id: all[0].id, args: { ...all[all.length - 1].args, waits: all.length } });
      }
      debug("rollout-total", { thread: thread ? thread.slice(0, 8) : null, scans, agents, held: held.size, errors });
      return finished;
    },
  };
}

export type { RolloutAgent, RolloutScan };
