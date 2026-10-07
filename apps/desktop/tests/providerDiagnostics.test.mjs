import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, STALE_AFTER_MS } from '../src/lib/providerDiagnostics.ts';

const now = 1_000_000_000_000;

test('never checked: unchecked, not stale', () => {
  const d = diagnose({ now });
  assert.equal(d.state, 'unchecked');
  assert.equal(d.stale, false);
  assert.equal(d.checkedAt, null);
});

test('a fresh ok status is ok; an old one is marked stale but keeps its state', () => {
  assert.deepEqual(diagnose({ now, health: { status: 'ok', message: '', at: now - 1000 } }), {
    state: 'ok',
    detail: '',
    checkedAt: now - 1000,
    stale: false,
  });
  const old = diagnose({ now, health: { status: 'ok', message: '', at: now - STALE_AFTER_MS - 1 } });
  assert.equal(old.state, 'ok');
  assert.equal(old.stale, true);
});

test('a status saved before timestamps existed counts as stale', () => {
  const d = diagnose({ now, health: { status: 'error', message: 'boom' } });
  assert.equal(d.stale, true);
  assert.equal(d.checkedAt, null);
});

test("auth and error carry the provider's message; a model-listing error is shown when no check was made", () => {
  assert.deepEqual(diagnose({ now, health: { status: 'auth', message: 'not signed in', at: now } }).state, 'auth');
  assert.equal(diagnose({ now, health: { status: 'error', message: '429', at: now } }).detail, '429');
  const d = diagnose({ now, listError: '401 from /models' });
  assert.equal(d.state, 'error');
  assert.equal(d.detail, '401 from /models');
});

test('a missing CLI explains itself, but a recent successful run beats a failed detection', () => {
  assert.equal(diagnose({ now, cliFound: false }).state, 'cliMissing');
  assert.equal(
    diagnose({ now, cliFound: false, health: { status: 'auth', message: 'x', at: now } }).state,
    'cliMissing',
  );
  assert.equal(diagnose({ now, cliFound: false, health: { status: 'ok', message: '', at: now } }).state, 'ok');
  assert.equal(diagnose({ now, cliFound: undefined }).state, 'unchecked');
});

test('disabled wins', () => {
  assert.equal(diagnose({ now, disabled: true, health: { status: 'error', message: 'x', at: now } }).state, 'disabled');
});
