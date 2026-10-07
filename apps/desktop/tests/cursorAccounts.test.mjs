import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cursorAccountEnv,
  profileName,
  PROFILE_NAME,
  normalizePool,
  migrateBackups,
  pickAccount,
  markExhausted,
  markAvailable,
  setActive,
  addToPool,
  removeFromPool,
  moveInPool,
  resolveAccount,
  EMPTY_POOL,
} from '../src/providers/cursorAccounts.ts';

const backup = { id: 'reserve', cli: 'cursor-agent', cliAuth: 'key' };
const primary = { id: 'primary', cli: 'cursor-agent' };
test('separate CLI credentials stay out of provider config; missing key cannot use shared login', () => {
  assert.deepEqual(cursorAccountEnv(backup, ' cursor_test '), { CURSOR_API_KEY: 'cursor_test' });
  assert.throws(() => cursorAccountEnv(backup, ''));
  assert.deepEqual(cursorAccountEnv(primary, 'ignored'), {});
  assert.deepEqual(cursorAccountEnv({ cli: 'codex' }, 'ignored'), {});
});
test('profile accounts get an isolated config dir; bad or missing profile is refused', () => {
  const prof = { id: 'p', cli: 'cursor-agent', cliProfile: 'acc-m1x2' };
  assert.deepEqual(cursorAccountEnv(prof, '', '/data/cursor-profiles/acc-m1x2'), {
    CURSOR_CONFIG_DIR: '/data/cursor-profiles/acc-m1x2',
  });
  assert.throws(() => cursorAccountEnv(prof, ''));
  assert.throws(() => cursorAccountEnv({ ...prof, cliProfile: '../x' }, '', '/d'));
  // The profile wins over a stale key; an api key is never set for a profile account.
  assert.deepEqual(cursorAccountEnv({ ...prof, cliAuth: 'key' }, 'k', '/d'), { CURSOR_CONFIG_DIR: '/d' });
  assert.deepEqual(cursorAccountEnv({ id: 'c', cli: 'claude', cliProfile: 'acc-1' }, '', '/d'), {});
});
test('generated profile names are valid', () => {
  assert.match(profileName(1759480000000), PROFILE_NAME);
  for (const bad of ['', 'A', 'a/b', '..', '-a', 'a-', 'a b']) assert.doesNotMatch(bad, PROFILE_NAME);
});

const acc = (id, extra = {}) => ({
  id,
  name: id,
  kind: 'cli',
  baseUrl: '',
  cli: 'cursor-agent',
  cliProfile: id,
  ...extra,
});
const A = acc('a'),
  B = acc('b'),
  C = acc('c');
const key = acc('k', { cliProfile: undefined, cliAuth: 'key' });
const providers = [A, B, C, key];
const pool = (ids, rest = {}) => ({ ids, exhausted: {}, ...rest });
const NOW = 1_000_000;
const until = (n) => ({ until: n, reason: 'x' });

test('migration: backupProviderId becomes an ordered pool without losing the providers', () => {
  const prim = { id: 'p', name: 'p', kind: 'cli', baseUrl: '', cli: 'cursor-agent', backupProviderId: 'k' };
  const out = migrateBackups([prim, key], EMPTY_POOL);
  assert.equal(out.changed, true);
  assert.deepEqual(out.pool.ids, ['p', 'k']);
  assert.equal(out.providers.length, 2);
  assert.ok(out.providers.every((p) => !('backupProviderId' in p)));
  assert.equal(out.providers[0].id, 'p');
  // Idempotent, and an existing pool order wins.
  assert.equal(migrateBackups(out.providers, out.pool).changed, false);
  assert.deepEqual(migrateBackups([prim, key], pool(['k'])).pool.ids, ['k', 'p']);
  // A dangling backup is dropped from the data without a pool entry.
  const bad = migrateBackups([{ ...prim, backupProviderId: 'gone' }], EMPTY_POOL);
  assert.deepEqual(bad.pool.ids, []);
  assert.equal('backupProviderId' in bad.providers[0], false);
});

test('normalizePool drops unknown ids, duplicates and malformed data', () => {
  const n = normalizePool(
    { ids: ['a', 'a', 'zzz', 5, 'b'], active: 'zzz', exhausted: { a: until(5), zzz: until(5), b: { until: 'x' } } },
    providers,
  );
  assert.deepEqual(n, { ids: ['a', 'b'], exhausted: { a: { until: 5, reason: 'x' } } });
  assert.deepEqual(normalizePool(null, providers), EMPTY_POOL);
  assert.deepEqual(normalizePool('junk', providers), EMPTY_POOL);
  assert.equal(normalizePool({ ids: ['a'], active: 'a' }, providers).active, 'a');
});

test('round robin: stay on the active account, move on when exhausted, wrap around', () => {
  let p = pool(['a', 'b', 'c'], { active: 'a' });
  assert.deepEqual(pickAccount(p, providers, NOW), { ok: true, id: 'a', switched: false });
  p = markExhausted(p, 'a', NOW + 1000, 'quota');
  assert.deepEqual(pickAccount(p, providers, NOW), { ok: true, id: 'b', switched: true });
  p = setActive(p, 'b');
  assert.deepEqual(pickAccount(p, providers, NOW), { ok: true, id: 'b', switched: false });
  p = markExhausted(p, 'b', NOW + 2000, 'quota');
  assert.equal(pickAccount(p, providers, NOW).id, 'c');
  p = markExhausted(setActive(p, 'c'), 'c', NOW + 3000, 'quota');
  const all = pickAccount(p, providers, NOW);
  assert.deepEqual(all, { ok: false, reason: 'exhausted', earliest: NOW + 1000 });
  // After a's reset time passes the pool wraps back to it, reported as a switch from c.
  assert.deepEqual(pickAccount(p, providers, NOW + 1000), { ok: true, id: 'a', switched: true });
  // Manual "mark available" clears one account.
  assert.deepEqual(pickAccount(markAvailable(p, 'b'), providers, NOW), { ok: true, id: 'b', switched: true });
});

test('without an active account the first one is used, an empty or disabled pool is an error', () => {
  assert.deepEqual(pickAccount(pool(['a', 'b']), providers, NOW), { ok: true, id: 'a', switched: false });
  assert.equal(pickAccount(EMPTY_POOL, providers, NOW).ok, false);
  assert.deepEqual(pickAccount(pool(['a', 'b']), [{ ...A, disabled: true }, B], NOW), {
    ok: true,
    id: 'b',
    switched: false,
  });
  assert.equal(pickAccount(pool(['a']), [{ ...A, disabled: true }], NOW).reason, 'empty');
});

test('API-key accounts are fallbacks: only used when every other account is exhausted', () => {
  const p = pool(['k', 'a', 'b'], { active: 'k' });
  assert.equal(pickAccount(p, providers, NOW).id, 'a');
  const both = pool(['k', 'a', 'b'], { active: 'a', exhausted: { a: until(NOW + 5), b: until(NOW + 5) } });
  assert.equal(pickAccount(both, providers, NOW).id, 'k');
  assert.equal(pickAccount(both, providers, NOW + 5).id, 'a');
});

test('pool edits: add, remove, reorder, active', () => {
  let p = addToPool(addToPool(EMPTY_POOL, 'a'), 'b');
  assert.deepEqual(addToPool(p, 'a').ids, ['a', 'b']);
  assert.deepEqual(moveInPool(p, 'b', -1).ids, ['b', 'a']);
  assert.deepEqual(moveInPool(p, 'a', -1).ids, ['a', 'b']);
  p = setActive(markExhausted(p, 'a', NOW + 9, 'q'), 'a');
  assert.deepEqual(removeFromPool(p, 'a'), { ids: ['b'], exhausted: {} });
});

test('resolveAccount: pool picks the account; a provider outside the pool or a pool of one is used as is', () => {
  const models = [
    { providerId: 'a', id: 'auto' },
    { providerId: 'a', id: 'gpt-x' },
    { providerId: 'b', id: 'auto' },
    { providerId: 'b', id: 'sonnet' },
  ];
  const base = { providers, models, selected: A, model: 'gpt-x', now: NOW };
  const p = pool(['a', 'b'], { active: 'a' });
  assert.deepEqual(resolveAccount({ ...base, pool: p }), { ok: true, provider: A, model: 'gpt-x' });
  const ex = markExhausted(p, 'a', NOW + 50, 'q');
  const r = resolveAccount({ ...base, pool: ex });
  assert.equal(r.provider.id, 'b');
  assert.equal(r.switchedFrom.id, 'a');
  // gpt-x is missing on b: fall back to auto with a note.
  assert.deepEqual([r.model, r.modelFallback], ['auto', { from: 'gpt-x', to: 'auto' }]);
  // A model that exists on b is kept; b without a loaded model list keeps the model.
  assert.equal(resolveAccount({ ...base, model: 'auto', pool: ex }).modelFallback, undefined);
  assert.equal(resolveAccount({ ...base, models: [], pool: ex }).model, 'gpt-x');
  // Everything exhausted: error with the earliest reset.
  const dead = markExhausted(ex, 'b', NOW + 70, 'q');
  assert.deepEqual(resolveAccount({ ...base, pool: dead }), { ok: false, earliest: NOW + 50 });
  // Not in the pool / pool of one: unchanged, no gating.
  assert.equal(resolveAccount({ ...base, selected: C, pool: dead }).provider, C);
  assert.equal(resolveAccount({ ...base, pool: pool(['a'], { exhausted: { a: until(NOW + 9) } }) }).provider, A);
  assert.equal(resolveAccount({ ...base, selected: { ...A, cli: 'claude' }, pool: ex }).provider.cli, 'claude');
});
