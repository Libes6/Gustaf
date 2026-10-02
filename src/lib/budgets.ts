// Token budgets and quota alerts. Pure logic only (no Tauri, no React) so it is unit-tested in tests/budgets.test.mjs.
// Tokens are the only unit: providers here do not report prices, so no cost is estimated or shown.
// Missing telemetry is never treated as "zero usage, all fine": it yields 'unavailable' or 'partial'.
import type { LimitWindow } from '../providers/types.ts';
import { isReportedUsage, totalTokens } from '../providers/usage.ts';

export const BUDGETS_SETTING = 'budgets';
export const DEFAULT_WARN_PERCENT = 80;
/** A quota snapshot without a reset time is not trusted after this long. */
export const QUOTA_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export type BudgetSettings = { dayTokens: number | null; chatTokens: number | null; warnPercent: number };
export const DEFAULT_BUDGETS: BudgetSettings = { dayTokens: null, chatTokens: null, warnPercent: DEFAULT_WARN_PERCENT };

const tokenLimit = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) return null;
  const n = Math.floor(v);
  return Number.isSafeInteger(n) ? n : null;
};
const percent = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 99 ? Math.round(v) : null;

/** Accepts whatever was persisted (possibly missing or corrupt) and returns valid settings. null = no limit. */
export function normalizeBudgets(raw: unknown): BudgetSettings {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return { dayTokens: tokenLimit(r.dayTokens), chatTokens: tokenLimit(r.chatTokens), warnPercent: percent(r.warnPercent) ?? DEFAULT_WARN_PERCENT };
}

export type ParsedLimit = { ok: true; value: number | null } | { ok: false };
/** Parses a limit typed by the user: empty = no limit, `500000`, `500 000`, `500,000`, `500k`, `1.5m`, `1,5м`. */
export function parseTokenLimit(text: string): ParsedLimit {
  const s = text.replace(/[\s  _]/g, '');
  if (!s) return { ok: true, value: null };
  let n: number;
  const suffix = /^(\d+(?:[.,]\d+)?)([kKкК]|[mMмМ])$/.exec(s);
  if (suffix) n = Number(suffix[1].replace(',', '.')) * (/[kKкК]/.test(suffix[2]) ? 1e3 : 1e6);
  else if (/^\d+$/.test(s)) n = Number(s);
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) n = Number(s.replace(/,/g, ''));
  else return { ok: false };
  n = Math.round(n);
  return Number.isSafeInteger(n) && n >= 1 ? { ok: true, value: n } : { ok: false };
}

/** Parses the warning threshold: a whole percentage from 1 to 99. */
export function parseWarnPercent(text: string): number | undefined {
  const s = text.trim().replace(/%$/, '').trim();
  return /^\d{1,2}$/.test(s) ? percent(Number(s)) ?? undefined : undefined;
}

// ---- local calendar day ----
export const localDayStart = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const nextLocalDayStart = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); return d.getTime(); };
export const localDayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---- usage from stored chat messages ----
export type UsageRecord = {
  role?: string;
  createdAt: number;
  /** The stored JSON could not be read. */
  unreadable?: boolean;
  meta?: { provider?: string; model?: string; usage?: unknown; imported?: unknown; compacted?: boolean } | null;
};
export type UsageTotals = { tokens: number; counted: number; missing: number };

/** Turns a `messages` row into a record. Unparseable content is kept as unreadable instead of being dropped. */
export function parseUsageRow(row: { role?: unknown; created_at?: unknown; content?: unknown }): UsageRecord {
  const role = typeof row.role === 'string' ? row.role : undefined;
  const createdAt = typeof row.created_at === 'number' ? row.created_at : 0;
  try {
    const parsed = JSON.parse(String(row.content));
    return { role, createdAt, meta: parsed && typeof parsed === 'object' ? parsed.meta ?? null : null };
  } catch { return { role, createdAt, unreadable: true }; }
}

/** True when a provider request produced this message, so a missing `usage` means unknown telemetry (not zero). */
export function expectsUsage(m: UsageRecord): boolean {
  if (m.meta?.imported) return false;
  if (m.meta?.compacted) return true;
  return m.role === 'assistant' && (m.unreadable === true || !!m.meta?.provider || !!m.meta?.model);
}

/** Sums provider-reported tokens. `missing` counts provider replies that carried no usable counts. */
export function summarizeUsage(records: UsageRecord[], range?: { from: number; to: number }): UsageTotals {
  const totals: UsageTotals = { tokens: 0, counted: 0, missing: 0 };
  for (const m of records) {
    if (range && !(m.createdAt >= range.from && m.createdAt < range.to)) continue;
    const usage = m.meta?.usage;
    if (isReportedUsage(usage)) { totals.tokens += totalTokens(usage); totals.counted++; }
    else if (expectsUsage(m)) totals.missing++;
  }
  return totals;
}

/**
 * Adds tokens that are not stored as chat messages (background subagents, see `agentUsage` in agent/agentRunsModel.ts).
 * Unreadable totals stay unreadable.
 */
export const withExtraTokens = (t: UsageTotals | undefined, extra: number): UsageTotals | undefined =>
  t && extra > 0 ? { ...t, tokens: t.tokens + extra, counted: t.counted + 1 } : t;

/** Tokens in the local calendar day containing `now`. A new local date starts from zero again. */
export const summarizeDay = (records: UsageRecord[], now: number): UsageTotals =>
  summarizeUsage(records, { from: localDayStart(now), to: nextLocalDayStart(now) });

// ---- budget evaluation ----
export type BudgetLevel = 'off' | 'unavailable' | 'ok' | 'partial' | 'warning' | 'exceeded';
export type BudgetStatus = { level: BudgetLevel; limit: number | null; tokens: number | null; percent: number | null; missing: number };

/**
 * `totals` undefined means usage could not be read: 'unavailable', never 'ok'.
 * Reported tokens are a lower bound when some replies had no counts, so a limit that is already
 * crossed stays crossed, but staying under it is only 'partial', and no data at all is 'unavailable'.
 */
export function evaluateBudget(limit: number | null, totals: UsageTotals | undefined, warnPercent = DEFAULT_WARN_PERCENT): BudgetStatus {
  const tokens = totals?.tokens ?? null;
  const missing = totals?.missing ?? 0;
  const pct = tokens !== null && limit !== null ? tokens / limit * 100 : null;
  const status = (level: BudgetLevel): BudgetStatus => ({ level, limit, tokens, percent: pct, missing });
  if (limit === null) return status('off');
  if (!totals) return status('unavailable');
  if (totals.tokens > limit) return status('exceeded');
  if (totals.tokens * 100 >= limit * warnPercent) return status('warning');
  if (totals.counted === 0 && totals.missing > 0) return status('unavailable');
  return status(totals.missing > 0 ? 'partial' : 'ok');
}

// ---- account quota windows (Codex / Claude) ----
export type QuotaLevel = 'ok' | 'warning' | 'exhausted' | 'stale' | 'unavailable';
export type QuotaStatus = { id: string; label: string; level: QuotaLevel; usedPercent: number | null; resetsAt?: number; plan?: string };
export type QuotaSnapshot = { windows: LimitWindow[]; checkedAt?: number };

/**
 * `resetsAt` is in seconds. A window that has reset since the snapshot was taken is 'stale' (current usage
 * unknown), not 'ok'. Without a reset time, a snapshot older than QUOTA_MAX_AGE_MS is stale too.
 */
export function evaluateWindow(w: LimitWindow, checkedAt: number | undefined, now: number, warnPercent = DEFAULT_WARN_PERCENT): QuotaStatus {
  const base = { id: w.id, label: w.label, resetsAt: w.resetsAt, plan: w.plan };
  const used = w.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return { ...base, level: 'unavailable', usedPercent: null };
  const stale = typeof w.resetsAt === 'number' ? w.resetsAt * 1000 <= now : typeof checkedAt !== 'number' || now - checkedAt > QUOTA_MAX_AGE_MS;
  if (stale) return { ...base, level: 'stale', usedPercent: used };
  return { ...base, usedPercent: used, level: used >= 100 ? 'exhausted' : used >= warnPercent ? 'warning' : 'ok' };
}
export const quotaStatuses = (snapshot: QuotaSnapshot | undefined, now: number, warnPercent = DEFAULT_WARN_PERCENT): QuotaStatus[] =>
  (snapshot?.windows ?? []).map(w => evaluateWindow(w, snapshot?.checkedAt, now, warnPercent));

// ---- alerts for the banner ----
export type BudgetAlert =
  | { key: string; kind: 'day' | 'chat'; level: 'warning' | 'exceeded' | 'unavailable'; tokens: number | null; limit: number; percent: number | null; missing: number }
  | { key: string; kind: 'quota'; level: 'warning' | 'exhausted'; providerId: string; label: string; usedPercent: number; resetsAt?: number };

export type AlertInput = {
  settings: BudgetSettings;
  now: number;
  /** undefined while loading or unreadable: no alert is produced, and nothing is reported as fine. */
  day?: UsageTotals;
  chatId?: number | null;
  chat?: UsageTotals;
  /** Only providers listed here produce quota alerts. */
  quotaProviders?: string[];
  limits?: Record<string, QuotaSnapshot | undefined>;
};

const RANK: Record<string, number> = { exceeded: 0, exhausted: 0, warning: 1, unavailable: 2 };

/** Alerts that need attention, most severe first. 'ok', 'off', 'partial' and stale quota windows produce none. */
export function buildAlerts(i: AlertInput): BudgetAlert[] {
  const out: BudgetAlert[] = [];
  const { settings } = i;
  const budget = (kind: 'day' | 'chat', limit: number | null, totals: UsageTotals | undefined, scope: string) => {
    const s = evaluateBudget(limit, totals, settings.warnPercent);
    if (limit === null || !totals || (s.level !== 'warning' && s.level !== 'exceeded' && s.level !== 'unavailable')) return;
    out.push({ key: `${kind}:${scope}:${s.level}`, kind, level: s.level, tokens: s.tokens, limit, percent: s.percent, missing: s.missing });
  };
  budget('day', settings.dayTokens, i.day, localDayKey(i.now));
  if (i.chatId != null) budget('chat', settings.chatTokens, i.chat, String(i.chatId));
  for (const providerId of i.quotaProviders ?? []) {
    for (const w of quotaStatuses(i.limits?.[providerId], i.now, settings.warnPercent)) {
      if ((w.level === 'warning' || w.level === 'exhausted') && w.usedPercent !== null) {
        out.push({ key: `quota:${providerId}:${w.id}:${w.level}:${w.resetsAt ?? ''}`, kind: 'quota', level: w.level, providerId, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt });
      }
    }
  }
  return out.sort((a, b) => RANK[a.level] - RANK[b.level]);
}
