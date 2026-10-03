import type { TokenUsage, LimitWindow } from './types';
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
/** Provider-reported counts only; missing telemetry stays unknown. Cached counts are subsets. */
export function tokenUsage(raw: any, anthropic = false): TokenUsage | undefined {
  if (!raw) return;
  const base = count(raw.input_tokens ?? raw.prompt_tokens ?? raw.inputTokens);
  const output = count(raw.output_tokens ?? raw.completion_tokens ?? raw.outputTokens);
  if (base === undefined || output === undefined) return;
  const cached = count(raw.cache_read_input_tokens ?? raw.cached_input_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens) ?? 0;
  const cacheWrite = count(raw.cache_creation_input_tokens) ?? 0;
  return { input: base + (anthropic ? cached + cacheWrite : 0), output, cached, cacheWrite, reasoning: count(raw.output_tokens_details?.reasoning_tokens ?? raw.completion_tokens_details?.reasoning_tokens) ?? 0 };
}
/** Stored/persisted usage is only trusted when input and output are finite non-negative numbers. */
export function isReportedUsage(raw: unknown): raw is TokenUsage {
  const u = raw as Partial<TokenUsage> | null | undefined;
  return !!u && typeof u === 'object' && count(u.input) !== undefined && count(u.output) !== undefined;
}
/** Input + output only: cached, cache-write and reasoning counts are subsets already included in these. */
export const totalTokens = (u: Pick<TokenUsage, 'input' | 'output'>): number => u.input + u.output;
export function codexLimits(result: any): LimitWindow[] {
  const buckets = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : result?.rateLimits ? [result.rateLimits] : [];
  return buckets.flatMap((b: any) => ['primary', 'secondary'].flatMap(key => {
    const w = b[key];
    const used = count(w?.usedPercent);
    if (used === undefined || used > 100) return [];
    return [{ id: `${b.limitId ?? 'codex'}:${key}`, label: `${b.limitName ?? b.limitId ?? 'Codex'} · ${w.windowDurationMins % 1440 === 0 ? `${w.windowDurationMins / 1440}d` : w.windowDurationMins % 60 === 0 ? `${w.windowDurationMins / 60}h` : `${w.windowDurationMins ?? '?'} min`}`, usedPercent: used, resetsAt: count(w.resetsAt), plan: b.planType }];
  }));
}
export function claudeLimit(event: any): LimitWindow | undefined {
  if (event?.type !== 'rate_limit_event') return;
  const r = event.rate_limit_info;
  const used = count(r?.utilization);
  if (used === undefined || used > 1) return;
  return { id: r.rateLimitType ?? 'claude', label: r.rateLimitType ?? 'Claude', usedPercent: used * 100, resetsAt: count(r.resetsAt) };
}
