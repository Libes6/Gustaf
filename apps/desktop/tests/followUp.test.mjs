import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./helpers/hooks.mjs', import.meta.url);
await import('./helpers/apiStub.mjs');
const { normalizeFollowUp, resolveFollowUp, followUpPlan, leadingClarifications, nextQueued, DEFAULT_FOLLOW_UP } =
  await import('../src/lib/followUp.ts');
const {
  setShortcutOverrides,
  shortcut,
  matches,
  validateBinding,
  effectiveShortcuts,
  findConflicts,
  EDITABLE_SHORTCUTS,
} = await import('../src/lib/shortcuts.ts');
afterEach(() => setShortcutOverrides({}));

const item = (id, clarify = false) => ({ id, text: id, images: [], clarify });
const idle = { running: false, coordinatorBusy: false, draining: false, aborting: false, loaded: true };
const key = (k, o = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

test('default action is queueing and a bad saved value falls back to it', () => {
  assert.equal(DEFAULT_FOLLOW_UP, 'queue');
  assert.equal(normalizeFollowUp(undefined), 'queue');
  assert.equal(normalizeFollowUp('nonsense'), 'queue');
  assert.equal(normalizeFollowUp('steer'), 'steer');
  assert.equal(resolveFollowUp('queue', false, true), 'queue');
  assert.equal(resolveFollowUp('steer', false, true), 'steer');
});

test('the opposite shortcut flips the default in both directions', () => {
  assert.equal(resolveFollowUp('queue', true, true), 'steer');
  assert.equal(resolveFollowUp('steer', true, true), 'queue');
});

test('the opposite shortcut is registered, editable, Cmd+Enter by default, and conflict-checked', () => {
  const s = shortcut('followUpOpposite');
  assert.equal(s.combo, 'Cmd+Enter');
  assert.equal(s.scope, 'composer');
  assert.ok(EDITABLE_SHORTCUTS.includes('followUpOpposite'));
  assert.ok(matches(key('Enter', { metaKey: true }), 'followUpOpposite'));
  assert.ok(!matches(key('Enter'), 'followUpOpposite'));
  assert.ok(!matches(key('Enter', { metaKey: true, altKey: true }), 'followUpOpposite'));
  assert.deepEqual(findConflicts(effectiveShortcuts()), []);
  // taking the send-and-new-chat keys is refused; another free combination is accepted and persisted as an override
  const clash = validateBinding('followUpOpposite', 'Cmd+Alt+Enter');
  assert.equal(clash.ok, false);
  assert.equal(clash.with, 'sendNewChat');
  assert.equal(validateBinding('followUpOpposite', 'Cmd+Shift+Enter').ok, true);
  setShortcutOverrides({ followUpOpposite: 'Cmd+Shift+Enter' });
  assert.ok(matches(key('Enter', { metaKey: true, shiftKey: true }), 'followUpOpposite'));
  assert.ok(!matches(key('Enter', { metaKey: true }), 'followUpOpposite'));
});

test('a provider without steering can only queue, whatever the setting or the shortcut says', () => {
  for (const mode of ['queue', 'steer'])
    for (const opposite of [false, true]) assert.equal(resolveFollowUp(mode, opposite, false), 'queue');
  assert.deepEqual(followUpPlan('steer', false), { action: 'queue', other: null, canSteer: false });
  assert.deepEqual(followUpPlan('steer', true), { action: 'steer', other: 'queue', canSteer: true });
  assert.deepEqual(followUpPlan('queue', true), { action: 'queue', other: 'steer', canSteer: true });
});

test('only leading clarifications join the running turn (FIFO)', () => {
  assert.deepEqual(
    leadingClarifications([item('a', true), item('b', true), item('c'), item('d', true)]).map((i) => i.id),
    ['a', 'b'],
  );
  assert.deepEqual(leadingClarifications([item('c'), item('d', true)]), []);
});

test('no parallel runs: the next queued message starts only when the chat is idle', () => {
  const q = { items: [item('a'), item('b')], paused: false };
  assert.equal(nextQueued(q, idle).id, 'a');
  for (const busy of ['running', 'coordinatorBusy', 'draining', 'aborting'])
    assert.equal(nextQueued(q, { ...idle, [busy]: true }), null, busy);
  assert.equal(nextQueued(q, { ...idle, loaded: false }), null);
  assert.equal(nextQueued({ ...q, paused: true }, idle), null);
  assert.equal(nextQueued({ items: [], paused: false }, idle), null);
  assert.equal(nextQueued(undefined, idle), null);
  // a steering message queued behind a normal one never jumps ahead: FIFO start order is kept
  assert.equal(nextQueued({ items: [item('first'), item('steer', true)], paused: false }, idle).id, 'first');
});
