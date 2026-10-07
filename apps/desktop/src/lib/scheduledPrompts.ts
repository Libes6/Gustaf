// Scheduled prompts: pure data model, validation and schedule math (no Tauri, no React, no clock of its own: every
// function takes `now` / `from`), unit-tested in tests/scheduledPrompts.test.mjs. Runs only happen while the app is
// open; `planTick` decides what a periodic check should do. Execution is in scheduledRun.ts, storage in
// scheduledPromptsStore.ts.
//
// Safety rules enforced here, not only in the UI:
//  - an unattended run never gets "full" access (`capAccess`), never Computer Use (the runner passes false);
//  - a schedule only runs after the user switched it on explicitly (`confirmedAt`); stored data that says
//    "enabled" without a confirmation is loaded as disabled, and a substantive edit asks for a new confirmation;
//  - at most MAX_SCHEDULES schedules, intervals of at least MIN_INTERVAL_MINUTES.

export const SCHEDULED_PROMPTS_SETTING = "scheduledPrompts";
export const MAX_SCHEDULES = 20;
export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 30 * 24 * 60;
/** A run that was due while the app was closed still happens if it is at most this late; otherwise it is recorded as missed. */
export const MISSED_WINDOW_MS = 24 * 60 * 60_000;
/** Scheduled runs that may be active at once; further due schedules wait for the next tick. */
export const MAX_CONCURRENT_RUNS = 2;
/** An unattended run that waits this long for an approval is stopped and marked "needs attention". */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const MAX_TITLE = 80;
export const MAX_PROMPT = 8000;
export const CHAT_PREFIX = "⏰ ";

export type ScheduleAccess = "readonly" | "auto";
export type Schedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string };
export type ScheduleKind = Schedule["kind"];
export type RunStatus = "running" | "success" | "failed" | "attention" | "stopped" | "missed" | "interrupted";

export type ScheduledPrompt = {
  id: string;
  title: string;
  prompt: string;
  projectId: number | null;
  providerId: string;
  model: string;
  access: ScheduleAccess;
  schedule: Schedule;
  enabled: boolean;
  /** When the user switched the schedule on in the UI. Without it the schedule never runs. */
  confirmedAt?: number;
  createdAt: number;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  lastError?: string;
  lastChatId?: number;
  nextRunAt?: number | null;
};

const STATUSES: readonly string[] = ["running", "success", "failed", "attention", "stopped", "missed", "interrupted"];

/** The lower of the chosen mode and "auto": unattended runs never get full access; anything unknown is read-only. */
export function capAccess(chosen: unknown): ScheduleAccess {
  return chosen === "auto" || chosen === "full" ? "auto" : "readonly";
}

// ---- time ----

export function parseTime(s: unknown): { h: number; m: number } | null {
  const hit = typeof s === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim()) : null;
  return hit ? { h: Number(hit[1]), m: Number(hit[2]) } : null;
}
export const formatTime = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/**
 * The first local wall-clock occurrence of `time` strictly after `from`, on a day accepted by `dayOk`.
 * Days are walked by calendar date, never by adding 24 h, so a DST change moves nothing: 09:00 stays 09:00. A time that
 * does not exist on a spring-forward day runs at the first valid moment after the gap (JS `Date` semantics) and one
 * that exists twice on a fall-back day runs once, at its first occurrence.
 */
function nextWallClock(from: number, time: string, dayOk: (weekday: number) => boolean): number | null {
  const t = parseTime(time);
  if (!t) return null;
  const base = new Date(from);
  for (let off = 0; off <= 8; off++) {
    // Noon avoids midnight DST gaps when asking which weekday a date is.
    const weekday = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off, 12).getDay();
    if (!dayOk(weekday)) continue;
    const at = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off, t.h, t.m, 0, 0).getTime();
    if (at > from) return at;
  }
  return null;
}

/** The next run strictly after `from` (for an interval: `from` plus the interval); null when there is none (a past one-off). */
export function nextRunAfter(schedule: Schedule, from: number): number | null {
  switch (schedule.kind) {
    case "once":
      return schedule.at > from ? schedule.at : null;
    case "interval":
      return from + schedule.everyMinutes * 60_000;
    case "daily":
      return nextWallClock(from, schedule.time, () => true);
    case "weekdays":
      return nextWallClock(from, schedule.time, (d) => d >= 1 && d <= 5);
  }
}

/** First `nextRunAt` of a freshly enabled schedule. A one-off keeps its own time (the missed-run policy then decides). */
export const initialNext = (schedule: Schedule, now: number): number | null =>
  schedule.kind === "once" ? schedule.at : nextRunAfter(schedule, now);

// ---- validation and normalization ----

export type DraftIssue = "title" | "prompt" | "promptLong" | "provider" | "interval" | "time" | "once" | "limit";
export type Draft = Pick<
  ScheduledPrompt,
  "title" | "prompt" | "projectId" | "providerId" | "model" | "access" | "schedule"
>;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** What is wrong with a schedule the user is about to save (empty list = fine). `count` is the number of other schedules. */
export function validateDraft(d: Draft, now: number, count: number): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (count >= MAX_SCHEDULES) issues.push("limit");
  if (!oneLine(d.title)) issues.push("title");
  if (!d.prompt.trim()) issues.push("prompt");
  else if (d.prompt.length > MAX_PROMPT) issues.push("promptLong");
  if (!d.providerId || !d.model) issues.push("provider");
  const s = d.schedule;
  if (
    s.kind === "interval" &&
    !(
      Number.isInteger(s.everyMinutes) &&
      s.everyMinutes >= MIN_INTERVAL_MINUTES &&
      s.everyMinutes <= MAX_INTERVAL_MINUTES
    )
  )
    issues.push("interval");
  if ((s.kind === "daily" || s.kind === "weekdays") && !parseTime(s.time)) issues.push("time");
  if (s.kind === "once" && !(Number.isFinite(s.at) && s.at > now)) issues.push("once");
  return issues;
}

function normalizeSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "once") return typeof r.at === "number" && Number.isFinite(r.at) ? { kind: "once", at: r.at } : null;
  if (r.kind === "interval") {
    if (typeof r.everyMinutes !== "number" || !Number.isFinite(r.everyMinutes)) return null;
    return {
      kind: "interval",
      everyMinutes: Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(r.everyMinutes))),
    };
  }
  if (r.kind === "daily" || r.kind === "weekdays") {
    const t = parseTime(r.time);
    return t ? { kind: r.kind, time: formatTime(t.h, t.m) } : null;
  }
  return null;
}

const finiteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Accepts whatever was persisted (possibly missing, hand-edited or corrupt) and returns valid schedules. */
export function normalizeScheduled(raw: unknown): ScheduledPrompt[] {
  if (!Array.isArray(raw)) return [];
  const out: ScheduledPrompt[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const schedule = normalizeSchedule(e.schedule);
    const title = typeof e.title === "string" ? oneLine(e.title).slice(0, MAX_TITLE) : "";
    const prompt = typeof e.prompt === "string" ? e.prompt.slice(0, MAX_PROMPT) : "";
    if (typeof e.id !== "string" || !e.id || ids.has(e.id) || !schedule || !title || !prompt.trim()) continue;
    if (typeof e.providerId !== "string" || typeof e.model !== "string") continue;
    ids.add(e.id);
    const confirmedAt = finiteNumber(e.confirmedAt) ? e.confirmedAt : undefined;
    out.push({
      id: e.id,
      title,
      prompt,
      projectId: finiteNumber(e.projectId) ? e.projectId : null,
      providerId: e.providerId,
      model: e.model,
      access: capAccess(e.access),
      schedule,
      // Never trust "enabled" without an explicit confirmation made in the UI.
      enabled: e.enabled === true && confirmedAt !== undefined,
      ...(confirmedAt !== undefined ? { confirmedAt } : {}),
      createdAt: finiteNumber(e.createdAt) ? e.createdAt : 0,
      ...(finiteNumber(e.lastRunAt) ? { lastRunAt: e.lastRunAt } : {}),
      ...(typeof e.lastStatus === "string" && STATUSES.includes(e.lastStatus)
        ? { lastStatus: e.lastStatus as RunStatus }
        : {}),
      ...(typeof e.lastError === "string" && e.lastError ? { lastError: e.lastError.slice(0, 300) } : {}),
      ...(finiteNumber(e.lastChatId) ? { lastChatId: e.lastChatId } : {}),
      ...(finiteNumber(e.nextRunAt) || e.nextRunAt === null ? { nextRunAt: e.nextRunAt as number | null } : {}),
    });
    if (out.length >= MAX_SCHEDULES) break;
  }
  return out;
}

/** A run that was "running" when the app closed did not finish. */
export const recoverInterrupted = (list: ScheduledPrompt[]): ScheduledPrompt[] =>
  list.map((s) => (s.lastStatus === "running" ? { ...s, lastStatus: "interrupted" as const } : s));

export function createSchedule(d: Draft, id: string, now: number): ScheduledPrompt {
  return {
    id,
    title: oneLine(d.title).slice(0, MAX_TITLE),
    prompt: d.prompt,
    projectId: d.projectId,
    providerId: d.providerId,
    model: d.model,
    access: capAccess(d.access),
    schedule: d.schedule,
    enabled: false,
    createdAt: now,
  };
}

const sameSchedule = (a: Schedule, b: Schedule) => JSON.stringify(a) === JSON.stringify(b);

/** Applies an edit. Anything that changes what runs or when switches the schedule off: the user has to confirm it again. */
export function editSchedule(s: ScheduledPrompt, d: Draft): ScheduledPrompt {
  const next: ScheduledPrompt = {
    ...s,
    title: oneLine(d.title).slice(0, MAX_TITLE),
    prompt: d.prompt,
    projectId: d.projectId,
    providerId: d.providerId,
    model: d.model,
    access: capAccess(d.access),
    schedule: d.schedule,
  };
  const changed =
    s.prompt !== d.prompt ||
    s.projectId !== d.projectId ||
    s.providerId !== d.providerId ||
    s.model !== d.model ||
    s.access !== capAccess(d.access) ||
    !sameSchedule(s.schedule, d.schedule);
  if (!changed) return next;
  const { confirmedAt: _drop, ...rest } = next;
  return { ...rest, enabled: false, nextRunAt: null };
}

/** The user switched a schedule on (or off) in the UI. Returns null when it cannot run (a one-off in the past). */
export function setEnabled(s: ScheduledPrompt, on: boolean, now: number): ScheduledPrompt | null {
  if (!on) return { ...s, enabled: false, nextRunAt: null };
  if (s.schedule.kind === "once" && s.schedule.at <= now) return null;
  return { ...s, enabled: true, confirmedAt: now, nextRunAt: initialNext(s.schedule, now) };
}

export function canAddSchedule(count: number) {
  return count < MAX_SCHEDULES;
}

// ---- the periodic check ----

export type TickPlan = {
  /** Schedules to start now (their patch already marks them running and advances `nextRunAt`). */
  start: string[];
  /** Schedules whose time passed more than 24 h ago while the app was closed: recorded as missed. */
  missed: string[];
  patches: { id: string; patch: Partial<ScheduledPrompt> }[];
};

/** `nextRunAt` after a run that starts (or an occurrence that is skipped) at `now`; a one-off is done. */
function advance(s: ScheduledPrompt, now: number): Partial<ScheduledPrompt> {
  if (s.schedule.kind === "once") return { nextRunAt: null, enabled: false };
  return { nextRunAt: nextRunAfter(s.schedule, now) };
}

/**
 * What a check at `now` should do. Policy:
 *  - disabled or unconfirmed schedules never run;
 *  - an enabled schedule without `nextRunAt` just gets one;
 *  - due at most 24 h ago (also after the app was closed): runs once, however many occurrences were passed over;
 *  - due more than 24 h ago: skipped and recorded as "missed";
 *  - still running from its previous occurrence: this occurrence is dropped (no overlap, no queue);
 *  - at most `maxConcurrent` scheduled runs at a time, the rest stay due until the next check.
 * `running` holds the ids of schedules with an active run.
 */
export function planTick(
  list: readonly ScheduledPrompt[],
  now: number,
  running: ReadonlySet<string>,
  maxConcurrent = MAX_CONCURRENT_RUNS,
): TickPlan {
  const plan: TickPlan = { start: [], missed: [], patches: [] };
  let slots = Math.max(0, maxConcurrent - running.size);
  const due = list
    .filter((s) => s.enabled && s.confirmedAt !== undefined)
    .map((s) => ({ s, at: s.nextRunAt ?? null }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  for (const { s, at } of due) {
    if (at === null) {
      plan.patches.push({ id: s.id, patch: { nextRunAt: initialNext(s.schedule, now) } });
      continue;
    }
    if (at > now) continue;
    if (running.has(s.id)) {
      plan.patches.push({ id: s.id, patch: advance(s, now) });
      continue;
    }
    if (now - at > MISSED_WINDOW_MS) {
      plan.missed.push(s.id);
      plan.patches.push({ id: s.id, patch: { lastStatus: "missed", lastError: undefined, ...advance(s, now) } });
      continue;
    }
    if (slots <= 0) continue;
    slots--;
    plan.start.push(s.id);
    plan.patches.push({
      id: s.id,
      patch: { lastRunAt: now, lastStatus: "running", lastError: undefined, ...advance(s, now) },
    });
  }
  return plan;
}

export function applyPatches(list: readonly ScheduledPrompt[], patches: TickPlan["patches"]): ScheduledPrompt[] {
  if (!patches.length) return [...list];
  const byId = new Map<string, Partial<ScheduledPrompt>>();
  for (const p of patches) byId.set(p.id, { ...byId.get(p.id), ...p.patch });
  return list.map((s) => (byId.has(s.id) ? { ...s, ...byId.get(s.id) } : s));
}

/** The patch recorded when a run ends. */
export function finishPatch(
  status: Exclude<RunStatus, "running" | "missed" | "interrupted">,
  chatId: number | null,
  error?: string,
): Partial<ScheduledPrompt> {
  return {
    lastStatus: status,
    lastError: error ? error.slice(0, 300) : undefined,
    ...(chatId !== null ? { lastChatId: chatId } : {}),
  };
}

/** Title of the chat a schedule writes to. */
export const chatTitle = (s: Pick<ScheduledPrompt, "title">) => `${CHAT_PREFIX}${s.title}`;
