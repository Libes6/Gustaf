import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src-tauri/src/bridge.rs', import.meta.url), 'utf8');
const script = source.split('const INIT_SCRIPT: &str = r#"')[1].split('"#;')[0]
  .replaceAll('__GUSTAF_VERSION__', '"test"')
  .replaceAll('__GUSTAF_BOOTSTRAPS__', '[]')
  .replaceAll('__GUSTAF_PLATFORM__', '"darwin"');

function load(invoke, stored = new Map()) {
  const events = new Map();
  const window = {
    __TAURI_INTERNALS__: { invoke: async (name, args) => {
      if (name === 'window_fullscreen_state') return false;
      return invoke(name, args);
    } },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    addEventListener: (name, listener) => events.set(name, listener),
  };
  window.top = window;
  vm.runInNewContext(script, {
    window, navigator: { language: 'ru', languages: ['ru'] }, EventTarget, Event, console,
  });
  return { window, bridge: window.desktopBridge };
}

test('fullscreen is a boolean and subscribers receive changes until unsubscribed', async () => {
  const { window, bridge } = load(() => null);
  await Promise.resolve();
  assert.equal(bridge.getWindowFullscreenState(), false);
  const changes = [];
  const unsubscribe = bridge.onWindowFullscreenStateChange((value) => changes.push(value));
  window.__gustafFullscreenState(true);
  window.__gustafFullscreenState(true);
  assert.equal(bridge.getWindowFullscreenState(), true);
  unsubscribe();
  window.__gustafFullscreenState(false);
  assert.deepEqual(changes, [true]);
});

test('migrates browser preferences only after native storage accepts them', async () => {
  const stored = new Map([['gustaf.clientSettings', '{"chatWidth":"wide"}']]);
  let saved;
  const { bridge } = load((name, args) => {
    if (name === 'read_client_settings') return null;
    if (name === 'write_client_settings') saved = args.settings;
  }, stored);
  assert.equal((await bridge.getClientSettings()).chatWidth, 'wide');
  assert.equal(saved.chatWidth, 'wide');
  assert.equal(stored.has('gustaf.clientSettings'), false);
});

test('a failed migration keeps the original preferences for retry', async () => {
  const stored = new Map([['gustaf.clientSettings', '{}']]);
  const { bridge } = load((name) => {
    if (name === 'read_client_settings') return null;
    throw new Error('disk full');
  }, stored);
  await assert.rejects(bridge.getClientSettings(), /disk full/);
  assert.equal(stored.get('gustaf.clientSettings'), '{}');
});

test('native preferences take priority over old origin storage', async () => {
  const { bridge } = load((name) => {
    assert.equal(name, 'read_client_settings');
    return { chatWidth: 'comfortable' };
  }, new Map([['gustaf.clientSettings', '{invalid'] ]));
  assert.equal((await bridge.getClientSettings()).chatWidth, 'comfortable');
});

test('window actions use native commands and propagate failures', async () => {
  const calls = [];
  const { bridge } = load((name, args) => {
    calls.push([name, args]);
    if (name === 'set_window_theme') throw new Error('window closed');
  });
  await bridge.revealWindow();
  assert.equal(calls[0][0], 'reveal_window');
  await assert.rejects(bridge.setTheme('dark'), /window closed/);
  assert.equal(calls[1][1].theme, 'dark');
});

test('catalog migration removes plaintext only after secure persistence succeeds', async () => {
  const stored = new Map([['gustaf.connectionCatalog', 'legacy-token']]);
  let secure = null;
  let fail = true;
  const { bridge } = load((name, args) => {
    if (name === 'read_connection_catalog') return secure;
    if (name === 'write_connection_catalog') {
      if (fail) throw new Error('keyring locked');
      secure = args.catalog;
    }
  }, stored);
  await assert.rejects(bridge.getConnectionCatalog(), /keyring locked/);
  assert.equal(stored.get('gustaf.connectionCatalog'), 'legacy-token');
  fail = false;
  assert.equal(await bridge.getConnectionCatalog(), 'legacy-token');
  assert.equal(secure, 'legacy-token');
  assert.equal(stored.has('gustaf.connectionCatalog'), false);
});

test('secure catalog takes priority and removes a leftover plaintext copy', async () => {
  const stored = new Map([['gustaf.connectionCatalog', 'obsolete-token']]);
  const { bridge } = load((name) => {
    assert.equal(name, 'read_connection_catalog');
    return 'saved-token';
  }, stored);
  assert.equal(await bridge.getConnectionCatalog(), 'saved-token');
  assert.equal(stored.has('gustaf.connectionCatalog'), false);
});

test('a failed secure read never falls back to plaintext or overwrites the catalog', async () => {
  const stored = new Map([['gustaf.connectionCatalog', 'obsolete-token']]);
  const { bridge } = load((name) => {
    assert.equal(name, 'read_connection_catalog');
    throw new Error('key missing');
  }, stored);
  await assert.rejects(bridge.getConnectionCatalog(), /key missing/);
  assert.equal(stored.get('gustaf.connectionCatalog'), 'obsolete-token');
});

test('a save queued during migration wins over the older catalog', async () => {
  const stored = new Map([['gustaf.connectionCatalog', 'legacy-token']]);
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  let secure = null;
  const { bridge } = load(async (name, args) => {
    if (name === 'read_connection_catalog') {
      await ready;
      return secure;
    }
    if (name === 'write_connection_catalog') secure = args.catalog;
  }, stored);
  const migrating = bridge.getConnectionCatalog();
  const saving = bridge.setConnectionCatalog('new-token');
  release();
  assert.equal(await migrating, 'legacy-token');
  assert.equal(await saving, true);
  assert.equal(secure, 'new-token');
  assert.equal(stored.has('gustaf.connectionCatalog'), false);
});
