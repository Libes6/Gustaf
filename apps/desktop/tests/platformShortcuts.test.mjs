import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesCombo, cmdKey, shortcut, shortcutDisplay, acceleratorOf, SHORTCUTS } from '../src/lib/shortcuts.ts';
import { displayKeys } from '../src/lib/platform.ts';
import { isSearchShortcut } from '../src/lib/searchUtil.ts';

const key = (k, o = {}) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o });

test('Cmd in a combo is Command on macOS and Ctrl elsewhere', () => {
  assert.ok(matchesCombo(key('k', { metaKey: true }), 'Cmd+K', 'macos'));
  assert.ok(!matchesCombo(key('k', { ctrlKey: true }), 'Cmd+K', 'macos'));
  assert.ok(matchesCombo(key('k', { ctrlKey: true }), 'Cmd+K', 'windows'));
  assert.ok(matchesCombo(key('k', { ctrlKey: true }), 'Cmd+K', 'linux'));
  assert.ok(!matchesCombo(key('k', { metaKey: true }), 'Cmd+K', 'windows'));
  assert.ok(!matchesCombo(key('k', { ctrlKey: true, metaKey: true }), 'Cmd+K', 'linux'));
  assert.ok(matchesCombo(key('Escape'), 'Escape', 'windows'));
  assert.ok(matchesCombo(key('5', { ctrlKey: true }), 'Cmd+1-9', 'linux'));
});

test('cmdKey', () => {
  assert.ok(cmdKey(key('x', { metaKey: true }), 'macos'));
  assert.ok(!cmdKey(key('x', { ctrlKey: true }), 'macos'));
  assert.ok(cmdKey(key('x', { ctrlKey: true }), 'windows'));
  assert.ok(!cmdKey(key('x'), 'linux'));
});

test('display text and accelerators per platform', () => {
  assert.equal(displayKeys('⌘,', 'macos'), '⌘,');
  assert.equal(displayKeys('⌘,', 'windows'), 'Ctrl+,');
  assert.equal(displayKeys('⌘⇧Esc', 'linux'), 'Ctrl+Shift+Esc');
  assert.equal(displayKeys('⌘↵', 'linux'), 'Ctrl+Enter');
  assert.equal(displayKeys('⌘1–9', 'linux'), 'Ctrl+1-9');
  assert.equal(shortcutDisplay(shortcut('search'), 'windows'), 'Ctrl+K');
  assert.equal(shortcutDisplay(shortcut('stopAgent'), 'macos'), '⌘⇧Esc');
  // Ctrl+Shift+Esc opens Task Manager on Windows, so the global shortcut differs there.
  assert.equal(acceleratorOf('stopAgent', 'windows'), 'Control+Alt+Shift+Escape');
  assert.equal(acceleratorOf('stopAgent', 'linux'), 'CommandOrControl+Shift+Escape');
  assert.equal(new Set(SHORTCUTS.map((s) => shortcutDisplay(s, 'windows'))).size, SHORTCUTS.length);
});

test('search shortcut follows the default (macOS) platform in tests', () => {
  assert.ok(isSearchShortcut(key('k', { metaKey: true })));
  assert.ok(!isSearchShortcut(key('k', { ctrlKey: true })));
});

test('the search shortcut works on a real event whose fields are prototype getters (not own properties)', () => {
  class FakeKeyboardEvent {
    constructor(init) {
      this._i = init;
    }
    get key() {
      return this._i.key;
    }
    get code() {
      return this._i.code;
    }
    get metaKey() {
      return !!this._i.metaKey;
    }
    get ctrlKey() {
      return !!this._i.ctrlKey;
    }
    get shiftKey() {
      return !!this._i.shiftKey;
    }
    get altKey() {
      return !!this._i.altKey;
    }
  }
  assert.ok(isSearchShortcut(new FakeKeyboardEvent({ key: 'k', code: 'KeyK', metaKey: true })));
  assert.ok(!isSearchShortcut(new FakeKeyboardEvent({ key: 'k', code: 'KeyK' })));
});
