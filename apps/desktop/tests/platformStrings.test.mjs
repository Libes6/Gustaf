import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyStoreKey, setPlatformForTests } from '../src/lib/platform.ts';

const load = (locale) => JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8'));
const dicts = { en: load('en'), ru: load('ru') };

// Keys that are shown only on macOS (or name the macOS store on purpose) and may say Mac/macOS/Dock.
const MAC_ONLY = new Set(['keyStoreMac']);

// The old app name, its identifiers and the owner's account name never appear in the interface.
const PATTERNS = [/\bMac\b/, /macOS/, /\bDock\b/i, /M Code/i, /\bmcode\b/i, /maksimkulakov/i];

for (const [locale, dict] of Object.entries(dicts)) {
  test(`${locale}: no Mac-only wording or old app name outside the allow-list`, () => {
    const offenders = Object.entries(dict)
      .filter(([key, value]) => !MAC_ONLY.has(key) && PATTERNS.some(re => re.test(value)))
      .map(([key, value]) => `${key}: ${value}`);
    assert.deepEqual(offenders, []);
  });
}

test('allow-listed keys exist in both locales', () => {
  for (const key of MAC_ONLY) for (const dict of Object.values(dicts)) assert.ok(key in dict, key);
});

test('keyStoreKey picks the store for each platform', () => {
  assert.equal(keyStoreKey('macos'), 'keyStoreMac');
  assert.equal(keyStoreKey('windows'), 'keyStoreWindows');
  assert.equal(keyStoreKey('linux'), 'keyStoreLinux');
  try {
    setPlatformForTests('linux');
    assert.equal(keyStoreKey(), 'keyStoreLinux');
    setPlatformForTests('windows');
    assert.equal(keyStoreKey(), 'keyStoreWindows');
  } finally {
    setPlatformForTests(undefined);
  }
  for (const dict of Object.values(dicts)) for (const p of ['macos', 'windows', 'linux']) assert.ok(dict[keyStoreKey(p)], p);
});

test('store placeholders are present in both locales', () => {
  for (const key of ['onbProviderLead', 'mcpOauthHint', 'mcpSecretHint', 'mcpImportHint'])
    for (const dict of Object.values(dicts)) assert.match(dict[key], /\{store\}/, key);
});
