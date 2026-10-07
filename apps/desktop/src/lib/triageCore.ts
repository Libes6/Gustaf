// Settle / snooze for chats in the sidebar's Recent list (T6). Pure: no React, no storage (tests/triage.test.mjs).
//  - Settled: the user is done with it; hidden from Recent until something new happens in it.
//  - Snoozed: hidden until a time; it comes back by itself then.
//  - Either one ends early when the chat needs attention (approval waiting, failed run, unread result).

export type Triage = { settledAt?: number; snoozedUntil?: number };
export type TriageMap = Record<number, Triage>;
export const TRIAGE_LIMIT = 500;

export function parseTriage(value: unknown): TriageMap {
  const out: TriageMap = {};
  if (!value || typeof value !== "object") return out;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(-TRIAGE_LIMIT)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id <= 0 || !v || typeof v !== "object") continue;
    const e = { settledAt: n((v as Triage).settledAt), snoozedUntil: n((v as Triage).snoozedUntil) };
    if (e.settledAt || e.snoozedUntil) out[id] = e;
  }
  return out;
}

export const settle = (m: TriageMap, id: number, now: number): TriageMap => ({
  ...without(m, id),
  [id]: { settledAt: now },
});
export const snooze = (m: TriageMap, id: number, until: number): TriageMap => ({
  ...without(m, id),
  [id]: { snoozedUntil: until },
});
export function without(m: TriageMap, id: number): TriageMap {
  if (!(id in m)) return m;
  const { [id]: _gone, ...rest } = m;
  return rest;
}

export type Place = "attention" | "working" | "open" | "snoozed" | "settled";

/** Where a chat goes in Recent. Attention wins over everything; an expired snooze is open again. */
export function placeOf(
  id: number,
  m: TriageMap,
  status: "waiting" | "running" | "failed" | "unread" | null,
  now: number,
): Place {
  if (status === "waiting" || status === "failed" || status === "unread") return "attention";
  if (status === "running") return "working";
  const e = m[id];
  if (e?.snoozedUntil && e.snoozedUntil > now) return "snoozed";
  if (e?.settledAt) return "settled";
  return "open";
}

/** Entries to drop: snoozes that expired, and settled/snoozed chats that now need attention or got newer activity. */
export function wakeUps(
  m: TriageMap,
  now: number,
  attention: ReadonlySet<number>,
  updatedAt: ReadonlyMap<number, number>,
): number[] {
  return Object.entries(m).flatMap(([k, e]) => {
    const id = Number(k);
    const expired = !!e.snoozedUntil && e.snoozedUntil <= now;
    const newer = !!e.settledAt && (updatedAt.get(id) ?? 0) > e.settledAt;
    return expired || newer || attention.has(id) ? [id] : [];
  });
}

/** Snooze presets in local time: in an hour, this evening (18:00, or tomorrow's if past), tomorrow 9:00, next Monday 9:00. */
export function snoozePresets(now: number): { key: "hour" | "evening" | "tomorrow" | "nextWeek"; at: number }[] {
  const d = new Date(now);
  const at = (days: number, h: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    x.setHours(h, 0, 0, 0);
    return x.getTime();
  };
  const evening = at(0, 18) > now + 30 * 60_000 ? at(0, 18) : at(1, 18);
  const toMonday = (8 - d.getDay()) % 7 || 7;
  return [
    { key: "hour", at: now + 3600_000 },
    { key: "evening", at: evening },
    { key: "tomorrow", at: at(1, 9) },
    { key: "nextWeek", at: at(toMonday, 9) },
  ];
}
