import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BUDGETS, QUOTA_MAX_AGE_MS, buildAlerts, evaluateBudget, evaluateWindow, expectsUsage, localDayKey, localDayStart,
  nextLocalDayStart, normalizeBudgets, parseTokenLimit, parseUsageRow, parseWarnPercent, quotaStatuses, summarizeDay, summarizeUsage,
} from '../src/lib/budgets.ts';

const local = (y, m, d, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s).getTime();
const usage = (input, output, extra = {}) => ({ input, output, cached: 0, cacheWrite: 0, reasoning: 0, ...extra });
const reply = (createdAt, u, meta = {}) => ({ role: 'assistant', createdAt, meta: { provider: 'p', model: 'm', ...(u ? { usage: u } : {}), ...meta } });
const totals = (tokens, counted = 1, missing = 0) => ({ tokens, counted, missing });

test('settings are validated; corrupt or missing values fall back to defaults', () => {
  assert.deepEqual(normalizeBudgets(undefined), DEFAULT_BUDGETS);
  assert.deepEqual(normalizeBudgets('junk'), DEFAULT_BUDGETS);
  assert.deepEqual(normalizeBudgets({ dayTokens: 1000.9, chatTokens: -5, warnPercent: 150 }), { dayTokens: 1000, chatTokens: null, warnPercent: 80 });
  assert.deepEqual(normalizeBudgets({ dayTokens: 'abc', chatTokens: 0, warnPercent: 65.4 }), { dayTokens: null, chatTokens: null, warnPercent: 65 });
  assert.equal(normalizeBudgets({ dayTokens: Infinity }).dayTokens, null);
  assert.equal(DEFAULT_BUDGETS.warnPercent, 80);
});

test('limit input: empty means no limit, suffixes and separators are accepted, nonsense is rejected', () => {
  assert.deepEqual(parseTokenLimit(''), { ok: true, value: null });
  assert.deepEqual(parseTokenLimit('  '), { ok: true, value: null });
  assert.deepEqual(parseTokenLimit('500000'), { ok: true, value: 500000 });
  assert.deepEqual(parseTokenLimit('500 000'), { ok: true, value: 500000 });
  assert.deepEqual(parseTokenLimit('500 000'), { ok: true, value: 500000 });
  assert.deepEqual(parseTokenLimit('500,000'), { ok: true, value: 500000 });
  assert.deepEqual(parseTokenLimit('250k'), { ok: true, value: 250000 });
  assert.deepEqual(parseTokenLimit('1.5M'), { ok: true, value: 1500000 });
  assert.deepEqual(parseTokenLimit('1,5м'), { ok: true, value: 1500000 });
  for (const bad of ['0', '-1', 'abc', '1.5', '12k5', '1e6', '0k', '99999999999999999999']) assert.deepEqual(parseTokenLimit(bad), { ok: false }, bad);
  assert.equal(parseWarnPercent('80'), 80);
  assert.equal(parseWarnPercent(' 95 % '), 95);
  for (const bad of ['', '0', '100', 'x', '1.5', '-3']) assert.equal(parseWarnPercent(bad), undefined, bad);
});

test('day boundaries follow the local calendar date and roll over at local midnight', () => {
  const evening = local(2026, 3, 14, 23, 59, 59);
  const midnight = local(2026, 3, 15, 0, 0, 0);
  assert.equal(localDayKey(evening), '2026-03-14');
  assert.equal(localDayKey(midnight), '2026-03-15');
  assert.equal(localDayStart(evening), local(2026, 3, 14));
  assert.equal(nextLocalDayStart(evening), midnight);
  assert.equal(nextLocalDayStart(midnight), local(2026, 3, 16));
  assert.equal(nextLocalDayStart(local(2026, 12, 31, 12)), local(2027, 1, 1));
  const records = [reply(local(2026, 3, 14, 9), usage(100, 20)), reply(local(2026, 3, 14, 23, 59, 59), usage(5, 5)), reply(midnight, usage(1000, 1))];
  assert.equal(summarizeDay(records, evening).tokens, 130);
  assert.equal(summarizeDay(records, midnight).tokens, 1001);
  assert.equal(summarizeDay(records, local(2026, 3, 16, 8)).tokens, 0);
});

test('tokens are input plus output; cached, cache-write and reasoning are subsets and not added again', () => {
  const r = [reply(1, usage(100, 20, { cached: 80, cacheWrite: 10, reasoning: 5 })), reply(2, usage(10, 5))];
  assert.deepEqual(summarizeUsage(r), { tokens: 135, counted: 2, missing: 0 });
});

test('replies without provider counts are missing, not zero; imported and tool messages are ignored', () => {
  const records = [
    reply(1, usage(10, 5)),
    reply(2, undefined),
    reply(3, { input: 'x', output: 4 }),
    reply(4, { input: -1, output: 4 }),
    { role: 'assistant', createdAt: 5, meta: { imported: 'cursor' } },
    { role: 'tool', createdAt: 6, meta: undefined },
    { role: 'user', createdAt: 7, meta: null },
    { role: 'user', createdAt: 8, meta: { compacted: true } },
    { role: 'user', createdAt: 9, meta: { compacted: true, usage: usage(7, 3) } },
    { role: 'assistant', createdAt: 10, unreadable: true },
  ];
  assert.deepEqual(summarizeUsage(records), { tokens: 25, counted: 2, missing: 5 });
  assert.equal(expectsUsage({ role: 'assistant', createdAt: 0, meta: {} }), false);
});

test('stored rows are parsed; corrupt content is unreadable and counts as missing', () => {
  const ok = parseUsageRow({ role: 'assistant', created_at: 42, content: JSON.stringify({ role: 'assistant', parts: [], meta: { provider: 'p', usage: usage(3, 4) } }) });
  assert.equal(ok.createdAt, 42);
  assert.deepEqual(summarizeUsage([ok]), { tokens: 7, counted: 1, missing: 0 });
  const bad = parseUsageRow({ role: 'assistant', created_at: 43, content: '{not json' });
  assert.equal(bad.unreadable, true);
  assert.deepEqual(summarizeUsage([bad]), { tokens: 0, counted: 0, missing: 1 });
  assert.deepEqual(summarizeUsage([parseUsageRow({ role: 'assistant', created_at: 1, content: 'null' })]), { tokens: 0, counted: 0, missing: 0 });
});

test('budget thresholds: ok below, warning at the threshold, exceeded only above the limit', () => {
  assert.equal(evaluateBudget(1000, totals(799)).level, 'ok');
  assert.equal(evaluateBudget(1000, totals(800)).level, 'warning');
  assert.equal(evaluateBudget(1000, totals(1000)).level, 'warning');
  assert.equal(evaluateBudget(1000, totals(1001)).level, 'exceeded');
  assert.equal(evaluateBudget(1000, totals(500), 50).level, 'warning');
  assert.equal(evaluateBudget(1000, totals(0)).level, 'ok');
  const s = evaluateBudget(2000, totals(500));
  assert.deepEqual([s.limit, s.tokens, s.percent], [2000, 500, 25]);
});

test('no limit set is off; unreadable usage is unavailable, never ok', () => {
  assert.equal(evaluateBudget(null, totals(10 ** 9)).level, 'off');
  assert.equal(evaluateBudget(null, undefined).level, 'off');
  const unread = evaluateBudget(1000, undefined);
  assert.equal(unread.level, 'unavailable');
  assert.equal(unread.tokens, null);
});

test('missing provider counts make a budget unavailable or partial, but a crossed limit stays crossed', () => {
  assert.equal(evaluateBudget(1000, totals(0, 0, 3)).level, 'unavailable');
  assert.equal(evaluateBudget(1000, totals(100, 1, 2)).level, 'partial');
  assert.equal(evaluateBudget(1000, totals(900, 1, 2)).level, 'warning');
  assert.equal(evaluateBudget(1000, totals(1200, 1, 2)).level, 'exceeded');
  assert.equal(evaluateBudget(1000, totals(0, 0, 0)).level, 'ok');
});

test('quota windows: warning at the threshold, exhausted at 100, unknown values are unavailable', () => {
  const now = local(2026, 3, 14, 12);
  const soon = now / 1000 + 3600;
  const w = (usedPercent, extra = {}) => ({ id: 'codex:primary', label: 'Codex · 5h', usedPercent, resetsAt: soon, ...extra });
  assert.equal(evaluateWindow(w(79.9), now, now).level, 'ok');
  assert.equal(evaluateWindow(w(80), now, now).level, 'warning');
  assert.equal(evaluateWindow(w(100), now, now).level, 'exhausted');
  assert.equal(evaluateWindow(w(90), now, now, 95).level, 'ok');
  assert.equal(evaluateWindow(w(undefined), now, now).level, 'unavailable');
  assert.equal(evaluateWindow(w(NaN), now, now).usedPercent, null);
});

test('quota snapshots go stale after the reset time or, without one, after the maximum age', () => {
  const now = local(2026, 3, 14, 12);
  const high = { id: 'a', label: 'A', usedPercent: 99 };
  assert.equal(evaluateWindow({ ...high, resetsAt: now / 1000 - 1 }, now, now).level, 'stale');
  assert.equal(evaluateWindow({ ...high, resetsAt: now / 1000 }, now, now).level, 'stale');
  assert.equal(evaluateWindow({ ...high, resetsAt: now / 1000 + 1 }, now, now).level, 'warning');
  assert.equal(evaluateWindow(high, now - 1000, now).level, 'warning');
  assert.equal(evaluateWindow(high, now - QUOTA_MAX_AGE_MS - 1, now).level, 'stale');
  assert.equal(evaluateWindow(high, undefined, now).level, 'stale');
  assert.deepEqual(quotaStatuses(undefined, now), []);
  assert.equal(quotaStatuses({ windows: [high], checkedAt: now }, now).length, 1);
});

test('alerts: limits off and healthy usage are silent; day and chat warn and exceed independently', () => {
  const now = local(2026, 3, 14, 12);
  const base = { now, quotaProviders: [], limits: {} };
  assert.deepEqual(buildAlerts({ ...base, settings: DEFAULT_BUDGETS, day: totals(10 ** 9), chatId: 7, chat: totals(10 ** 9) }), []);
  const settings = { dayTokens: 1000, chatTokens: 500, warnPercent: 80 };
  assert.deepEqual(buildAlerts({ ...base, settings, day: totals(100), chatId: 7, chat: totals(100) }), []);
  const alerts = buildAlerts({ ...base, settings, day: totals(850), chatId: 7, chat: totals(600) });
  assert.deepEqual(alerts.map(a => [a.kind, a.level]), [['chat', 'exceeded'], ['day', 'warning']]);
  assert.equal(alerts[1].key, 'day:2026-03-14:warning');
  assert.equal(alerts[0].key, 'chat:7:exceeded');
});

test('alerts: the day key changes at local midnight so a dismissed alert returns on a new day', () => {
  const settings = { dayTokens: 1000, chatTokens: null, warnPercent: 80 };
  const a = buildAlerts({ settings, now: local(2026, 3, 14, 23, 59), day: totals(900) });
  const b = buildAlerts({ settings, now: local(2026, 3, 15, 0, 1), day: totals(900) });
  assert.notEqual(a[0].key, b[0].key);
  const exceeded = buildAlerts({ settings, now: local(2026, 3, 14, 23, 59), day: totals(1100) });
  assert.notEqual(a[0].key, exceeded[0].key);
});

test('alerts: unknown telemetry is reported as unavailable, while a draft chat or unread usage produces nothing', () => {
  const now = local(2026, 3, 14, 12);
  const settings = { dayTokens: 1000, chatTokens: 500, warnPercent: 80 };
  const alerts = buildAlerts({ settings, now, day: totals(0, 0, 4), chatId: 3, chat: totals(0, 0, 2) });
  assert.deepEqual(alerts.map(a => [a.kind, a.level, a.missing]), [['day', 'unavailable', 4], ['chat', 'unavailable', 2]]);
  assert.deepEqual(buildAlerts({ settings, now, day: undefined, chatId: 3, chat: undefined }), []);
  assert.deepEqual(buildAlerts({ settings, now, day: totals(10), chatId: null, chat: totals(10 ** 9) }), []);
  assert.deepEqual(buildAlerts({ settings, now, day: totals(10), chat: totals(10 ** 9) }), []);
});

test('alerts: only selected providers produce quota alerts; stale, healthy and unknown windows are silent', () => {
  const now = local(2026, 3, 14, 12);
  const future = now / 1000 + 600;
  const limits = {
    codex: { checkedAt: now, windows: [
      { id: 'codex:primary', label: 'Codex · 5h', usedPercent: 93, resetsAt: future },
      { id: 'codex:secondary', label: 'Codex · 7d', usedPercent: 100, resetsAt: future },
      { id: 'codex:old', label: 'Old', usedPercent: 99, resetsAt: now / 1000 - 60 },
      { id: 'codex:low', label: 'Low', usedPercent: 10, resetsAt: future },
    ] },
    claude: { checkedAt: now, windows: [{ id: 'five_hour', label: 'five_hour', usedPercent: 95, resetsAt: future }] },
  };
  const alerts = buildAlerts({ settings: DEFAULT_BUDGETS, now, limits, quotaProviders: ['codex'] });
  assert.deepEqual(alerts.map(a => [a.kind, a.level, a.label]), [['quota', 'exhausted', 'Codex · 7d'], ['quota', 'warning', 'Codex · 5h']]);
  assert.deepEqual(buildAlerts({ settings: DEFAULT_BUDGETS, now, limits, quotaProviders: [] }), []);
  assert.deepEqual(buildAlerts({ settings: DEFAULT_BUDGETS, now, limits, quotaProviders: ['missing'] }), []);
  assert.equal(buildAlerts({ settings: { ...DEFAULT_BUDGETS, warnPercent: 97 }, now, limits, quotaProviders: ['claude'] }).length, 0);
  assert.equal(buildAlerts({ settings: DEFAULT_BUDGETS, now, limits, quotaProviders: ['claude'] })[0].key, `quota:claude:five_hour:warning:${future}`);
});
