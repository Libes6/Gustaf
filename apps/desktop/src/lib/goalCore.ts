// Pure logic of chat goals (`/goal <objective>`): the agent keeps working turn after turn until it reports the goal met
// or blocked, the turn limit is reached, or the user stops or pauses it. No storage or UI here (tests/goals.test.mjs).

export type GoalStatus = "active" | "paused" | "done" | "blocked";
export type Goal = {
  objective: string;
  status: GoalStatus;
  /** Turns run for this goal, the first one included. */
  turns: number;
  maxTurns: number;
  /** Tokens reported by the provider over all goal turns. */
  tokens: number;
  startedAt: number;
  /** Why it is paused or blocked (the agent's reason, "stopped", "failed", "limit"). */
  note?: string;
  /** Driven by the provider (Codex `thread/goal/*`): no app-side turn loop, turns and limits do not apply. */
  native?: boolean;
};

/** A Codex thread goal status as ours. Usage and budget limits are pauses the user can resume. */
export function fromNativeStatus(s: string): { status: GoalStatus; note?: string } {
  switch (s) {
    case "complete": return { status: "done" };
    case "blocked": return { status: "blocked" };
    case "paused": return { status: "paused" };
    case "usageLimited": return { status: "paused", note: "usage" };
    case "budgetLimited": return { status: "paused", note: "budget" };
    default: return { status: "active" };
  }
}

export const newNativeGoal = (objective: string, now: number): Goal => ({ ...newGoal(objective, now), native: true });

export const DEFAULT_MAX_TURNS = 20;
export const MAX_OBJECTIVE = 2000;

/** `/goal fix the flaky tests` → "fix the flaky tests"; anything else → null. */
export function parseGoalCommand(text: string): string | null {
  const m = /^\/goal(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const objective = (m[1] ?? "").trim();
  return objective ? objective.slice(0, MAX_OBJECTIVE) : null;
}

export function newGoal(objective: string, now: number, maxTurns = DEFAULT_MAX_TURNS): Goal {
  return { objective, status: "active", turns: 0, maxTurns, tokens: 0, startedAt: now };
}

const PROTOCOL = [
  "Work toward this goal over as many turns as it takes; after each of your replies you will be asked to continue.",
  "Each turn, take the next concrete step and verify it.",
  "When the goal is fully met, end your reply with a line `GOAL: done` followed by a short summary.",
  "If you cannot continue without the user (a decision, access, missing information), end with `GOAL: blocked - <reason>`.",
].join(" ");

/** The first message of a goal. */
export const goalPrompt = (objective: string) => `Goal: ${objective}\n\n${PROTOCOL}`;

/** The message sent automatically after each turn that neither finished nor blocked the goal. */
export const continuePrompt = (g: Goal) =>
  `Continue working toward the goal: ${g.objective}\n(turn ${g.turns + 1} of ${g.maxTurns}) Take the next step. End with \`GOAL: done\` when it is fully met, or \`GOAL: blocked - <reason>\` if you need the user.`;

/** Reads the agent's report from the last assistant text of a turn: the last `GOAL:` line wins. */
export function goalReport(text: string): { kind: "done" | "blocked"; note: string } | null {
  const lines = [...text.matchAll(/^[ \t]*\**GOAL:\**[ \t]*(done|blocked)\b[ \t:—–-]*(.*)$/gim)];
  const last = lines[lines.length - 1];
  if (!last) return null;
  return { kind: last[1].toLowerCase() as "done" | "blocked", note: last[2].trim().slice(0, 300) };
}

/**
 * What happens after a goal turn ends. `outcome` is the run's end ("stopped" = the user pressed Stop), `lastText` the
 * last assistant text of the turn. Returns the updated goal and whether to queue a continuation.
 */
export function afterTurn(g: Goal, o: { outcome: "ok" | "failed" | "stopped"; lastText: string; tokens: number }): { goal: Goal; continueWith: string | null } {
  // Paused or cleared while the turn ran: count it, never continue.
  const counted: Goal = { ...g, turns: g.turns + 1, tokens: g.tokens + Math.max(0, o.tokens) };
  if (g.status !== "active") return { goal: counted, continueWith: null };
  if (o.outcome !== "ok") return { goal: { ...counted, status: "paused", note: o.outcome }, continueWith: null };
  const report = goalReport(o.lastText);
  if (report) return { goal: { ...counted, status: report.kind, note: report.note || undefined }, continueWith: null };
  if (counted.turns >= counted.maxTurns) return { goal: { ...counted, status: "paused", note: "limit" }, continueWith: null };
  return { goal: counted, continueWith: continuePrompt(counted) };
}

/** Resume a paused or blocked goal: active again, with room for at least a few more turns. */
export function resumeGoal(g: Goal): Goal {
  return { ...g, status: "active", note: undefined, maxTurns: Math.max(g.maxTurns, g.turns + 5) };
}

/** A queued message that is a goal continuation (removed from the queue when the goal is paused or cleared). */
export const isContinuation = (text: string) => text.startsWith("Continue working toward the goal: ");
