import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProviders, runProviderCheck } from '../src/lib/providerCheck.ts';

test('a check that works records an empty message', async () => {
  assert.equal(await runProviderCheck(async () => {}, 'timeout'), '');
});

test('a check that throws records the error text', async () => {
  assert.equal(
    await runProviderCheck(async () => {
      throw new Error('HTTP 503');
    }, 'timeout'),
    'HTTP 503',
  );
});

test('a check that runs too long is aborted and reports the given timeout text', async () => {
  const waitForAbort = (signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await runProviderCheck(waitForAbort, 'took too long', 20), 'took too long');
});

test('a check that ignores the abort but finishes late still reports the timeout', async () => {
  assert.equal(
    await runProviderCheck(() => new Promise((r) => setTimeout(r, 60)), 'took too long', 10),
    'took too long',
  );
});

test('check all: every provider is checked and a failure stays on its own provider', async () => {
  const recorded = {};
  const started = [];
  const check = async (p) => (p.id === 'b' ? 'HTTP 401' : p.id === 'c' ? Promise.reject(new Error('boom')) : '');
  await checkProviders(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    check,
    (id, m) => {
      recorded[id] = m;
    },
    (id) => started.push(id),
  );
  assert.deepEqual(recorded, { a: '', b: 'HTTP 401', c: 'boom', d: '' });
  assert.deepEqual(started, ['a', 'b', 'c', 'd', null]);
});
