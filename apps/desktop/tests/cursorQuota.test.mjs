import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuota, exhaustedUntil, markExhausted, markAvailable, pickAccount, DEFAULT_RESET_MS } from '../src/providers/cursorAccounts.ts';

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const hit = (s) => classifyQuota(s, NOW);

test('usage limit, quota and out-of-requests wording is exhaustion', () => {
 for (const s of [
  "You've hit your usage limit. Upgrade to Pro for more.",
  'Error: You are out of requests for this month',
  'Out of usage',
  'Monthly quota exceeded',
  'Request limit reached',
  'You have exceeded your usage allowance',
  'Reached your monthly limit.',
  'b: [resource_exhausted] Error: usage limit',
  'Upgrade your plan: free usage limit used',
 ]) assert.ok(hit(s), s);
});

test('unrelated or ambiguous errors are not exhaustion', () => {
 for (const s of [
  '', '   ',
  'rate limit',
  'Too many requests',
  'Upgrade to Pro',
  'context length exceeded: max tokens 200000',
  'Prompt is too long for the context window limit',
  '401 unauthorized: not logged in',
  'invalid api key',
  'spawn cursor-agent ENOENT',
  'Connection reset by peer',
  'cursor-agent exited with 1',
 ]) assert.equal(hit(s), null, s);
});

test('credential or size errors win over a stray limit word, unless the quota wording is explicit', () => {
 assert.equal(hit('unauthorized: usage unavailable, limit unknown'), null);
 assert.ok(hit('unauthorized client? no: you hit your usage limit'));
});

test('reset time: relative, absolute, none', () => {
 assert.equal(hit('Rate limit exceeded, try again in 2 hours 30 minutes').resetAt, NOW + 150 * 60_000);
 assert.equal(hit('Usage limit reached. Try again in 1h 5m').resetAt, NOW + 65 * 60_000);
 assert.equal(hit('Too many requests (429), quota. Retry after 90 seconds').resetAt, NOW + 90_000);
 assert.equal(hit('Usage limit reached. Try again in 3 days').resetAt, NOW + 3 * 86_400_000);
 assert.equal(hit('Your usage limit resets at 2026-10-04T00:00:00Z').resetAt, Date.UTC(2026, 9, 4));
 assert.equal(hit('You hit your usage limit.').resetAt, undefined);
 // A rate limit with a reset time counts; the same without one does not.
 assert.ok(hit('rate limit hit: resets at 2026-10-03T13:00:00Z usage'));
 assert.equal(hit('rate limit'), null);
 // Past or absurdly far dates are ignored (the account is parked for the default period instead).
 assert.equal(hit('Usage limit reached. resets at 2020-01-01T00:00:00Z').resetAt, undefined);
 assert.equal(hit('Usage limit reached. Try again in 400 days').resetAt, undefined);
});

test('parked until the reset time, default one hour, never under a minute', () => {
 assert.equal(exhaustedUntil({}, NOW), NOW + DEFAULT_RESET_MS);
 assert.equal(exhaustedUntil({ resetAt: NOW + 5 * 60_000 }, NOW), NOW + 5 * 60_000);
 assert.equal(exhaustedUntil({ resetAt: NOW + 1000 }, NOW), NOW + 60_000);
});

test('exhaustion bookkeeping drives the pick and survives a JSON round trip', () => {
 const prov = ['a', 'b'].map(id => ({ id, name: id, kind: 'cli', baseUrl: '', cli: 'cursor-agent', cliProfile: id }));
 let pool = { ids: ['a', 'b'], active: 'a', exhausted: {} };
 pool = markExhausted(pool, 'a', exhaustedUntil(hit('usage limit'), NOW), 'usage limit');
 pool = JSON.parse(JSON.stringify(pool));
 assert.equal(pickAccount(pool, prov, NOW).id, 'b');
 // Once the hour has passed the account is usable again without any bookkeeping.
 assert.equal(pickAccount({ ...pool, active: 'b', exhausted: { ...pool.exhausted, b: { until: NOW + 1, reason: '' } } }, prov, NOW + DEFAULT_RESET_MS).id, 'b');
 assert.equal(pickAccount(markAvailable(pool, 'a'), prov, NOW).id, 'a');
 // Marking an account that is not in the pool changes nothing.
 assert.equal(markExhausted(pool, 'zzz', NOW + 9, 'x'), pool);
});
