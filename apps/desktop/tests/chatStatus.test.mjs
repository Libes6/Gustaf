// Sidebar chat status: derivation and the unread/failed flag store (src/lib/chatStatus.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { deriveStatus, createStatusStore, parseUnread, UNREAD_LIMIT } = await import('../src/lib/chatStatus.ts');

test('deriveStatus: waiting beats running beats failed beats unread', () => {
  assert.equal(deriveStatus({}), null);
  assert.equal(deriveStatus({ unread: true }), 'unread');
  assert.equal(deriveStatus({ unread: true, failed: true }), 'failed');
  assert.equal(deriveStatus({ unread: true, failed: true, running: true }), 'running');
  assert.equal(deriveStatus({ unread: true, failed: true, running: true, waiting: true }), 'waiting');
});

test('a run that ends while the chat is not in front becomes unread; opening clears it', () => {
  const s = createStatusStore();
  s.runEnded(1, 'ok');
  assert.deepEqual([...s.get().unread], [1]);
  s.setViewing(1);
  assert.deepEqual([...s.get().unread], []);
});

test('a run that ends in the chat in front does not become unread', () => {
  const s = createStatusStore();
  s.setViewing(2);
  s.runEnded(2, 'ok');
  assert.deepEqual([...s.get().unread], []);
  s.setViewing(null);
  s.runEnded(2, 'ok');
  assert.deepEqual([...s.get().unread], [2], 'the window in the background counts as not viewing');
});

test('a failed run sets failed (not unread); the next start, success or open clears it', () => {
  const s = createStatusStore();
  s.runEnded(3, 'failed');
  assert.deepEqual([...s.get().failed], [3]);
  assert.deepEqual([...s.get().unread], []);
  s.runStarted(3);
  assert.deepEqual([...s.get().failed], []);
  s.runEnded(3, 'failed');
  s.runEnded(3, 'ok');
  assert.deepEqual([...s.get().failed], []);
  s.runEnded(4, 'failed');
  s.setViewing(4);
  assert.deepEqual([...s.get().failed], []);
});

test('a stopped run changes nothing, and listeners get a new snapshot per change', () => {
  const s = createStatusStore();
  let n = 0;
  s.subscribe(() => n++);
  const before = s.get();
  s.runEnded(5, 'stopped');
  assert.equal(n, 0);
  assert.equal(s.get(), before);
  s.runEnded(5, 'ok');
  assert.equal(n, 1);
  assert.notEqual(s.get(), before);
});

test('load restores persisted ids tolerantly and keeps the chat in front read', () => {
  const s = createStatusStore();
  s.setViewing(7);
  s.load([7, 8, 8, 'x', -1, 1.5, null, 9]);
  assert.deepEqual(s.unreadIds(), [8, 9]);
  assert.deepEqual(parseUnread('nope'), []);
});

test('the unread list is bounded and keeps the newest', () => {
  const s = createStatusStore();
  for (let i = 1; i <= UNREAD_LIMIT + 5; i++) s.runEnded(i, 'ok');
  const ids = s.unreadIds();
  assert.equal(ids.length, UNREAD_LIMIT);
  assert.equal(ids.at(-1), UNREAD_LIMIT + 5);
  assert.ok(!ids.includes(1));
  assert.equal(parseUnread(Array.from({ length: UNREAD_LIMIT + 10 }, (_, i) => i + 1)).length, UNREAD_LIMIT);
});

test('forget drops both flags', () => {
  const s = createStatusStore();
  s.runEnded(1, 'ok');
  s.runEnded(2, 'failed');
  s.forget(1);
  s.forget(2);
  assert.deepEqual([...s.get().unread, ...s.get().failed], []);
});
