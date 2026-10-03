import type { ProviderConfig } from './types';

/** Profile names are folder names under the app data dir; must match the Rust `validate_name`. */
export const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const profileName = (stamp: number) => `acc-${stamp.toString(36)}`;

/** Credentials travel in the child environment, never shell arguments or saved provider config.
 *  A browser-login profile account only needs its isolated config dir (`profileDir`, resolved by the backend). */
export function cursorAccountEnv(cfg: ProviderConfig, key: string, profileDir?: string): Record<string, string> {
  if (cfg.cli !== 'cursor-agent') return {};
  if (cfg.cliProfile) {
    if (!PROFILE_NAME.test(cfg.cliProfile) || !profileDir) throw new Error('Cursor account profile is missing.');
    return { CURSOR_CONFIG_DIR: profileDir };
  }
  if (cfg.cliAuth === 'key' && !key.trim()) throw new Error('Cursor account API key is missing.');
  return cfg.cliAuth === 'key' ? { CURSOR_API_KEY: key.trim() } : {};
}

// ---------------------------------------------------------------------------------------------
// Account pool. Every Cursor account is a provider (cli 'cursor-agent': the shared login, a browser-login
// profile or an API key). The pool is the ordered subset that takes part in rotation.

export type Exhaustion = { until: number; reason: string };
export type CursorPool = { ids: string[]; active?: string; exhausted: Record<string, Exhaustion> };
export const EMPTY_POOL: CursorPool = { ids: [], exhausted: {} };
/** Reset time assumed when the CLI does not say when the quota comes back. */
export const DEFAULT_RESET_MS = 60 * 60 * 1000;

export const isCursorAccount = (p: ProviderConfig | undefined): p is ProviderConfig => !!p && p.cli === 'cursor-agent' && !p.disabled;
/** API-key accounts are fallbacks: used only when no other pool account is available. */
const isFallback = (p: ProviderConfig) => p.cliAuth === 'key' && !p.cliProfile;

/** Keeps only well-formed data about accounts that still exist; unknown ids and duplicates are dropped. */
export function normalizePool(raw: unknown, providers: ProviderConfig[]): CursorPool {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<CursorPool>;
  const known = new Set(providers.filter(p => p.cli === 'cursor-agent').map(p => p.id));
  const ids = [...new Set(Array.isArray(r.ids) ? r.ids.filter((i): i is string => typeof i === 'string' && known.has(i)) : [])];
  const exhausted: Record<string, Exhaustion> = {};
  for (const [id, e] of Object.entries(r.exhausted && typeof r.exhausted === 'object' ? r.exhausted : {})) {
    if (ids.includes(id) && e && Number.isFinite(e.until)) exhausted[id] = { until: e.until, reason: typeof e.reason === 'string' ? e.reason.slice(0, 300) : '' };
  }
  return { ids, ...(r.active && ids.includes(r.active) ? { active: r.active } : {}), exhausted };
}

/** The old `backupProviderId` (one primary, one keyed backup) becomes an ordered pool: primary first, then its
 *  backup. Existing pool order wins; the legacy field is removed. Idempotent. */
export function migrateBackups(providers: ProviderConfig[], pool: CursorPool): { providers: ProviderConfig[]; pool: CursorPool; changed: boolean } {
  if (!providers.some(p => p.backupProviderId !== undefined)) return { providers, pool, changed: false };
  const ids = [...pool.ids];
  const add = (id: string) => { if (!ids.includes(id)) ids.push(id); };
  for (const p of providers) {
    const b = p.backupProviderId;
    if (!b || p.cli !== 'cursor-agent') continue;
    const backup = providers.find(x => x.id === b && x.id !== p.id && x.cli === 'cursor-agent');
    if (!backup) continue;
    add(p.id);
    add(backup.id);
  }
  return {
    providers: providers.map(({ backupProviderId, ...rest }) => rest),
    pool: normalizePool({ ...pool, ids }, providers),
    changed: true,
  };
}

const live = (pool: CursorPool, id: string, now: number) => !(pool.exhausted[id] && pool.exhausted[id].until > now);

export type Pick = { ok: true; id: string; switched: boolean } | { ok: false; reason: 'empty' | 'exhausted'; earliest?: number };

/** Round-robin: stay on the active account while it has quota; otherwise the next available one after it,
 *  wrapping around. API-key (fallback) accounts come only after every other account is exhausted. */
export function pickAccount(pool: CursorPool, providers: ProviderConfig[], now: number): Pick {
  const members = pool.ids.map(id => providers.find(p => p.id === id)).filter(isCursorAccount);
  if (!members.length) return { ok: false, reason: 'empty' };
  const start = Math.max(0, members.findIndex(p => p.id === pool.active));
  const rotated = [...members.slice(start), ...members.slice(0, start)];
  const next = [...rotated.filter(p => !isFallback(p)), ...rotated.filter(isFallback)].find(p => live(pool, p.id, now));
  if (next) return { ok: true, id: next.id, switched: pool.active !== undefined && pool.active !== next.id };
  return { ok: false, reason: 'exhausted', earliest: Math.min(...members.map(p => pool.exhausted[p.id]?.until ?? Infinity)) };
}

/** `active` stays the account that served the last message, so the next pick can report a switch. */
export function markExhausted(pool: CursorPool, id: string, until: number, reason: string): CursorPool {
  return pool.ids.includes(id) ? { ...pool, exhausted: { ...pool.exhausted, [id]: { until, reason: reason.slice(0, 300) } } } : pool;
}

export function markAvailable(pool: CursorPool, id: string): CursorPool {
  const { [id]: _gone, ...exhausted } = pool.exhausted;
  return { ...pool, exhausted };
}

/** Records that a turn is about to run on `id` (the new active account). */
export const setActive = (pool: CursorPool, id: string): CursorPool => (pool.active === id ? pool : { ...pool, active: id });

export const addToPool = (pool: CursorPool, id: string): CursorPool => (pool.ids.includes(id) ? pool : { ...pool, ids: [...pool.ids, id] });

export function removeFromPool(pool: CursorPool, id: string): CursorPool {
  const { [id]: _gone, ...exhausted } = pool.exhausted;
  return { ids: pool.ids.filter(i => i !== id), exhausted, ...(pool.active && pool.active !== id ? { active: pool.active } : {}) };
}

export function moveInPool(pool: CursorPool, id: string, by: -1 | 1): CursorPool {
  const i = pool.ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= pool.ids.length) return pool;
  const ids = [...pool.ids];
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return { ...pool, ids };
}

export type Resolved =
  | { ok: true; provider: ProviderConfig; model: string; switchedFrom?: ProviderConfig; modelFallback?: { from: string; to: string } }
  | { ok: false; earliest?: number };

/** Which account and model serve the next message. A provider outside the pool, or a pool of one, is used as
 *  selected (no gating: the CLI's own error is then the clearest answer). */
export function resolveAccount(o: { pool: CursorPool; providers: ProviderConfig[]; models: { providerId: string; id: string }[]; selected: ProviderConfig; model: string; now: number }): Resolved {
  const { pool, providers, selected, model, now } = o;
  const members = pool.ids.filter(id => isCursorAccount(providers.find(p => p.id === id)));
  if (!isCursorAccount(selected) || !members.includes(selected.id) || members.length < 2) return { ok: true, provider: selected, model };
  const pick = pickAccount(pool, providers, now);
  if (!pick.ok) return { ok: false, earliest: pick.earliest };
  const provider = providers.find(p => p.id === pick.id)!;
  const own = o.models.filter(m => m.providerId === provider.id).map(m => m.id);
  // An account whose model list is not loaded cannot be checked: keep the model rather than guess.
  const to = !own.length || own.includes(model) ? model : own.includes('auto') ? 'auto' : own.includes('default') ? 'default' : own[0];
  return {
    ok: true,
    provider,
    model: to,
    ...(pick.switched ? { switchedFrom: providers.find(p => p.id === pool.active) } : {}),
    ...(to !== model ? { modelFallback: { from: model, to } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Quota detection. Pure and conservative: a false positive parks a working account for an hour, a false
// negative just shows the CLI's own error. Patterns come from Cursor's usage-limit wording; the real
// cursor-agent output could not be captured here (the CLI is not logged in), so extend with real samples.

export type Quota = { resetAt?: number };

const STRONG = [
  /usage[ -]limit/i,
  /out of (?:fast |premium )?(?:requests|usage|credits)/i,
  /(?:quota|usage|request) (?:limit )?(?:exceeded|exhausted|reached)/i,
  /exceeded (?:your |the )?(?:usage|quota|monthly|plan|request)/i,
  /(?:hit|reached|used up) (?:your |the )?(?:\w+ )?(?:usage |monthly |plan |request )?(?:limit|quota)/i,
];
// Not account quota: per-request size limits and credential problems.
const NOT_QUOTA = /context (?:length|window)|too many tokens|prompt is too long|max(?:imum)? (?:output )?tokens|invalid api key|unauthori[sz]ed|not logged in/i;
const RATE_LIMIT = /rate[ -]limit|too many requests|resource_exhausted|\b429\b/i;
const UPGRADE = /\bupgrade\b/i;
const LIMITISH = /limit|quota|usage/i;
const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const MAX_RESET_MS = 40 * 86_400_000;

/** "in 2 hours 30 minutes", "in 1h 5m", "after 90 seconds", "in 3 days". */
function relativeMs(text: string): number | undefined {
  const m = /\b(?:in|after|again in|retry after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text);
  if (!m) return;
  let total = 0;
  for (const [, n, unit] of m[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) total += Number(n) * UNITS[unit[0].toLowerCase()];
  return total > 0 ? total : undefined;
}

/** "resets at 2026-10-04T00:00:00Z", "resets on Nov 1", "resets October 12, 2026". */
function absoluteMs(text: string, now: number): number | undefined {
  const m = /resets?(?: (?:at|on))?\s*:?\s*([A-Za-z0-9][A-Za-z0-9 ,:.+\-/]{3,40})/i.exec(text);
  if (!m) return;
  const raw = m[1].trim().replace(/[.,]$/, '');
  const year = new Date(now).getUTCFullYear();
  // The capture may run on into following words ("... 13:00:00Z usage"): shorten from the right until a date parses.
  const words = raw.split(/\s+/);
  for (let n = words.length; n > 0; n--) {
    const head = words.slice(0, n).join(' ').replace(/[.,]$/, '');
    for (const candidate of [head, `${head} ${year}`, `${head} ${year + 1}`]) {
      const t = Date.parse(candidate);
      if (Number.isFinite(t) && t > now && /\d{4}/.test(candidate)) return t;
    }
  }
}

/** Returns null for anything that is not clearly an exhausted account quota. `resetAt` is a ms timestamp when
 *  the text names one within the next 40 days. */
export function classifyQuota(text: string, now: number): Quota | null {
  const s = text.slice(0, 4000);
  if (!s.trim()) return null;
  const rel = relativeMs(s);
  const at = rel !== undefined ? now + rel : absoluteMs(s, now);
  const resetAt = at !== undefined && at > now && at - now <= MAX_RESET_MS ? at : undefined;
  const strong = STRONG.some(re => re.test(s));
  if (NOT_QUOTA.test(s) && !strong) return null;
  // A bare rate limit is usually transient; it counts only when the text says when it clears.
  const quota = strong || (UPGRADE.test(s) && LIMITISH.test(s)) || ((RATE_LIMIT.test(s) || /\bresets?\b/i.test(s)) && LIMITISH.test(s) && resetAt !== undefined);
  return quota ? { resetAt } : null;
}

/** When to try the account again: the stated reset time, else an hour from now (never less than a minute). */
export const exhaustedUntil = (q: Quota, now: number) => Math.max(q.resetAt ?? now + DEFAULT_RESET_MS, now + 60_000);
