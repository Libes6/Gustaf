import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS_SERIES, cellKey, dailyUsage, niceMax, rangeStart, stackSeries } from '../src/lib/usageDaily.ts';

const local = (y, m, d, h = 0, min = 0, s = 0, ms = 0) => new Date(y, m - 1, d, h, min, s, ms).getTime();
const u = (input, output, cached = 0) => ({ input, output, cached, cacheWrite: 0, reasoning: 0 });
const reply = (createdAt, usage, provider = 'p1', model = 'm1') => ({ role: 'assistant', createdAt, meta: { provider, model, ...(usage ? { usage } : {}) } });

test('the range covers N local days ending today and empty days are zero', () => {
  const now = local(2026, 10, 7, 15);
  const d = dailyUsage([], 7, now);
  assert.equal(d.days.length, 7);
  assert.equal(d.days[0].key, '2026-10-01');
  assert.equal(d.days[6].key, '2026-10-07');
  assert.equal(d.from, local(2026, 10, 1));
  assert.equal(d.to, local(2026, 10, 8));
  assert.ok(d.days.every(x => Object.keys(x.cells).length === 0 && x.agentTokens === 0));
  assert.equal(rangeStart(now, 1), local(2026, 10, 7));
});

test('day boundaries are local midnight (last millisecond vs first)', () => {
  const now = local(2026, 3, 15, 12);
  const d = dailyUsage([reply(local(2026, 3, 14, 23, 59, 59, 999), u(10, 1)), reply(local(2026, 3, 15, 0, 0, 0, 0), u(20, 2))], 3, now);
  const k = cellKey('p1', 'm1');
  assert.equal(d.days[1].key, '2026-03-14');
  assert.deepEqual(d.days[1].cells[k], { input: 10, output: 1, cached: 0, requests: 1 });
  assert.deepEqual(d.days[2].cells[k], { input: 20, output: 2, cached: 0, requests: 1 });
});

test('records outside the range are ignored; replies without counts are counted as missing', () => {
  const now = local(2026, 10, 7, 9);
  const d = dailyUsage([reply(local(2026, 9, 30, 23), u(5, 5)), reply(local(2026, 10, 8), u(5, 5)), reply(local(2026, 10, 7, 1), undefined), { role: 'user', createdAt: local(2026, 10, 7, 2), meta: null }], 7, now);
  assert.equal(d.missing, 1);
  assert.ok(d.days.every(x => Object.keys(x.cells).length === 0));
});

test('per-provider and per-model numbers add up, cached stays separate, agent ledger days are attached', () => {
  const now = local(2026, 10, 7, 9);
  const t = local(2026, 10, 7, 8);
  const d = dailyUsage([reply(t, u(100, 10, 40), 'a', 'x'), reply(t + 1, u(50, 5, 10), 'a', 'x'), reply(t + 2, u(7, 3), 'a', 'y'), reply(t + 3, u(1, 1), 'b', 'z')], 2, now, { '2026-10-07': 500, '2026-10-06': 0 });
  const byProvider = stackSeries(d, 'tokens', 'provider');
  assert.deepEqual(byProvider.days[1].parts, { a: 175, b: 2, [AGENTS_SERIES]: 500 });
  assert.equal(byProvider.total, 677);
  assert.deepEqual(byProvider.keys, [AGENTS_SERIES, 'a', 'b']);
  const byModel = stackSeries(d, 'tokens', 'model');
  assert.equal(byModel.days[1].parts[cellKey('a', 'x')], 165);
  assert.equal(byModel.days[1].parts[cellKey('a', 'y')], 10);
  assert.equal(stackSeries(d, 'cached', 'provider').total, 50);
  assert.equal(stackSeries(d, 'requests', 'provider').total, 4);
  assert.equal(stackSeries(d, 'input', 'provider').total, 158);
  assert.equal(stackSeries(d, 'output', 'provider').total, 19);
  assert.equal(stackSeries(d, 'cached', 'provider').days[0].total, 0);
});

test('a 90 day range across a DST change still has 90 distinct days', () => {
  const d = dailyUsage([], 90, local(2026, 10, 7, 12));
  assert.equal(new Set(d.days.map(x => x.key)).size, 90);
});

test('niceMax rounds the axis up', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(3), 5);
  assert.equal(niceMax(2100), 2500);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(100), 100);
});
