import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTCUTS,
  EDITABLE_SHORTCUTS,
  setShortcutOverrides,
  getShortcutOverrides,
  shortcut,
  matches,
  validateBinding,
  comboFromEvent,
  displayOfCombo,
  effectiveShortcuts,
  findConflicts,
  isTextEditingSafe,
  shortcutDisplay,
} from '../src/lib/shortcuts.ts';

const key = (k, o = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });
afterEach(() => setShortcutOverrides({}));

test('a rebound shortcut fires on the new keys only, and shows them', () => {
  setShortcutOverrides({ newChat: 'Cmd+Shift+J' });
  assert.ok(matches(key('j', { metaKey: true, shiftKey: true }), 'newChat'));
  assert.ok(!matches(key('n', { metaKey: true }), 'newChat'));
  assert.equal(shortcut('newChat').display, '⌘⇧J');
  assert.equal(shortcutDisplay(shortcut('newChat'), 'windows'), 'Ctrl+Shift+J');
});

test('reset: an empty map restores the defaults', () => {
  setShortcutOverrides({ newChat: 'Cmd+Shift+J' });
  setShortcutOverrides({});
  assert.ok(matches(key('n', { metaKey: true }), 'newChat'));
  assert.deepEqual(getShortcutOverrides(), {});
});

test('invalid saved bindings are ignored: unknown ids, fixed shortcuts, no Cmd, editing keys, conflicts', () => {
  setShortcutOverrides({ nope: 'Cmd+J', send: 'Cmd+J', newChat: 'J', settings: 'Cmd+C', search: 'Cmd+N', chatBack: 5 });
  assert.deepEqual(getShortcutOverrides(), {});
  assert.ok(matches(key('k', { metaKey: true }), 'search'));
});

test('two shortcuts can be swapped, in any key order', () => {
  setShortcutOverrides({ newChat: 'Cmd+K', search: 'Cmd+N' });
  assert.deepEqual(getShortcutOverrides(), { newChat: 'Cmd+K', search: 'Cmd+N' });
  assert.equal(findConflicts(effectiveShortcuts()).length, 0);
});

test('validateBinding explains why', () => {
  assert.deepEqual(validateBinding('newChat', 'Cmd+J'), { ok: true });
  assert.deepEqual(validateBinding('newChat', 'N'), { ok: false, error: 'needsCmd' });
  assert.deepEqual(validateBinding('newChat', 'Shift+N'), { ok: false, error: 'needsCmd' });
  assert.deepEqual(validateBinding('newChat', 'Cmd+V'), { ok: false, error: 'reserved' });
  assert.deepEqual(validateBinding('newChat', 'Cmd+Q'), { ok: false, error: 'reserved' });
  assert.deepEqual(validateBinding('newChat', 'Cmd+K'), { ok: false, error: 'conflict', with: 'search' });
  // a composer key and the model picker digits collide too (app shortcuts fire in the message box)
  assert.deepEqual(validateBinding('newChat', 'Cmd+3'), { ok: false, error: 'conflict', with: 'pickModel' });
  assert.deepEqual(validateBinding('newChat', 'Cmd+Alt+Enter'), { ok: false, error: 'conflict', with: 'sendNewChat' });
  assert.deepEqual(validateBinding('newChat', 'Cmd+N'), { ok: true });
  assert.deepEqual(validateBinding('send', 'Cmd+J'), { ok: false, error: 'unsupported' });
});

test('every editable shortcut stays safe for text editing with any valid binding', () => {
  setShortcutOverrides({ settings: 'Cmd+Shift+P', turnPrev: 'Cmd+Shift+ArrowUp' });
  assert.deepEqual(
    effectiveShortcuts()
      .filter((s) => !isTextEditingSafe(s))
      .map((s) => s.id),
    [],
  );
  assert.ok(EDITABLE_SHORTCUTS.every((id) => SHORTCUTS.some((s) => s.id === id)));
});

test('recording: letters by physical key, modifiers per platform, lone modifiers wait', () => {
  assert.equal(comboFromEvent(key('Meta', { metaKey: true }), 'macos'), null);
  assert.equal(
    comboFromEvent({ ...key('j', { metaKey: true, shiftKey: true }), code: 'KeyJ' }, 'macos'),
    'Cmd+Shift+J',
  );
  // a layout where the physical J key types another letter
  assert.equal(comboFromEvent({ ...key('о', { metaKey: true }), code: 'KeyJ' }, 'macos'), 'Cmd+J');
  assert.equal(comboFromEvent(key('p', { ctrlKey: true, altKey: true }), 'windows'), 'Cmd+Alt+P');
  assert.equal(comboFromEvent(key('p', { ctrlKey: true }), 'macos'), '');
  assert.equal(comboFromEvent(key('p', { metaKey: true }), 'linux'), '');
  assert.equal(comboFromEvent(key('ArrowUp', { metaKey: true }), 'macos'), 'Cmd+ArrowUp');
});

test('displayOfCombo', () => {
  assert.equal(displayOfCombo('Cmd+Alt+ArrowUp'), '⌘⌥↑');
  assert.equal(displayOfCombo('Cmd+,'), '⌘,');
});
