import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenUsage, codexLimits, claudeLimit, isReportedUsage, totalTokens } from '../src/providers/usage.ts';
test('missing telemetry stays unknown; cached and reasoning counts are subsets', () => {
 assert.equal(tokenUsage(undefined), undefined);
 assert.equal(tokenUsage({ input_tokens: 12 }), undefined);
 assert.deepEqual(tokenUsage({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 5 } }), { input: 100, output: 20, cached: 80, cacheWrite: 0, reasoning: 5 });
 assert.equal(tokenUsage({ input_tokens: -1, output_tokens: 4 }), undefined);
});
test('Claude cache reads and writes are added to input exactly once', () => {
 assert.deepEqual(tokenUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 }, true), { input: 110, output: 5, cached: 80, cacheWrite: 20, reasoning: 0 });
});
test('multi-bucket account limits take precedence and missing limits are not zero', () => {
 const windows = codexLimits({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1000 }, secondary: null } } });
 assert.equal(windows.length, 1); assert.equal(windows[0].usedPercent, 25);
 assert.deepEqual(codexLimits({ rateLimits: { primary: { usedPercent: null } } }), []);
 assert.equal(claudeLimit({ type: 'rate_limit_event', rate_limit_info: { utilization: .42, rateLimitType: 'five_hour' } }).usedPercent, 42);
 assert.equal(claudeLimit({ type: 'rate_limit_event', rate_limit_info: {} }), undefined);
});
test('stored usage is trusted only when input and output are valid; totals never double-count subsets', () => {
 assert.equal(isReportedUsage({ input: 1, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 }), true);
 for (const bad of [undefined, null, 5, {}, { input: 1 }, { input: -1, output: 2 }, { input: 'x', output: 2 }, { input: NaN, output: 2 }]) assert.equal(isReportedUsage(bad), false);
 assert.equal(totalTokens({ input: 100, output: 20, cached: 80, cacheWrite: 10, reasoning: 5 }), 120);
});
