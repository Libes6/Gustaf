// Daily usage series for Settings > Usage. Pure logic (no Tauri, no React); unit-tested in tests/usageDaily.test.mjs.
// Built from the provider-reported `meta.usage` stored with each chat message, grouped by local calendar day.
import { isReportedUsage } from "../providers/usage.ts";
import { localDayKey, localDayStart, nextLocalDayStart, type UsageRecord } from "./budgets.ts";

export const USAGE_RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

export type Cell = { input: number; output: number; cached: number; requests: number };
/** One local calendar day. `cells` is keyed by `providerId\tmodel`. `agentTokens` is the ledger total of background subagents (no provider split). */
export type DayBucket = { key: string; start: number; cells: Record<string, Cell>; agentTokens: number };
export type DailyUsage = {
  days: DayBucket[];
  from: number;
  to: number;
  /** Provider replies in range without usable token counts. */ missing: number;
};

export const cellKey = (providerId: string, model: string) => `${providerId}\t${model}`;
export const splitCellKey = (key: string): { providerId: string; model: string } => {
  const i = key.indexOf("\t");
  return { providerId: key.slice(0, i), model: key.slice(i + 1) };
};
export const emptyCell = (): Cell => ({ input: 0, output: 0, cached: 0, requests: 0 });

/** Start of the first day of a range of `count` local days that ends with the day containing `now`. */
export function rangeStart(now: number, count: number): number {
  const d = new Date(localDayStart(now));
  d.setDate(d.getDate() - (count - 1));
  return d.getTime();
}

/**
 * Groups records into `count` local days ending with today. Days without usage are present with zero values.
 * `agentDays` maps a local day key (`YYYY-MM-DD`) to background-subagent tokens.
 */
export function dailyUsage(
  records: UsageRecord[],
  count: number,
  now: number,
  agentDays: Record<string, number> = {},
): DailyUsage {
  const days: DayBucket[] = [];
  const byKey = new Map<string, DayBucket>();
  let start = rangeStart(now, count);
  const from = start;
  for (let i = 0; i < count; i++) {
    const key = localDayKey(start);
    const bucket: DayBucket = { key, start, cells: {}, agentTokens: agentDays[key] ?? 0 };
    days.push(bucket);
    byKey.set(key, bucket);
    start = nextLocalDayStart(start);
  }
  const to = start;
  let missing = 0;
  for (const r of records) {
    if (!(r.createdAt >= from && r.createdAt < to)) continue;
    const u = r.meta?.usage;
    if (!isReportedUsage(u)) {
      if (r.meta?.provider || r.meta?.model) missing++;
      continue;
    }
    const bucket = byKey.get(localDayKey(r.createdAt));
    if (!bucket) continue;
    const key = cellKey(r.meta?.provider ?? "", r.meta?.model ?? "");
    const c = (bucket.cells[key] ??= emptyCell());
    c.input += u.input;
    c.output += u.output;
    c.cached += u.cached ?? 0;
    c.requests++;
  }
  return { days, from, to, missing };
}

export type Metric = "tokens" | "input" | "output" | "cached" | "requests";
export type GroupBy = "provider" | "model";
export const AGENTS_SERIES = "\u0000agents";

const value = (c: Cell, m: Metric) => (m === "tokens" ? c.input + c.output : c[m]);

export type Stacked = {
  keys: string[];
  days: { day: DayBucket; parts: Record<string, number>; total: number }[];
  totals: Record<string, number>;
  total: number;
};

/** Per-day values of one metric split into series (providers or provider+model). Background agents add a series for the tokens metric. */
export function stackSeries(data: DailyUsage, metric: Metric, by: GroupBy): Stacked {
  const totals: Record<string, number> = {};
  const days = data.days.map((day) => {
    const parts: Record<string, number> = {};
    for (const [k, c] of Object.entries(day.cells)) {
      const s = by === "provider" ? splitCellKey(k).providerId : k;
      parts[s] = (parts[s] ?? 0) + value(c, metric);
    }
    if (metric === "tokens" && day.agentTokens > 0) parts[AGENTS_SERIES] = day.agentTokens;
    let total = 0;
    for (const [s, v] of Object.entries(parts)) {
      total += v;
      totals[s] = (totals[s] ?? 0) + v;
    }
    return { day, parts, total };
  });
  const keys = Object.keys(totals).sort((a, b) => totals[b] - totals[a] || a.localeCompare(b));
  return { keys, days, totals, total: days.reduce((a, d) => a + d.total, 0) };
}

/** "Nice" axis maximum: 1, 2, 2.5 or 5 times a power of ten, never below `max`. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}
