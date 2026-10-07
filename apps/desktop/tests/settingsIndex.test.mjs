import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { searchSettings, SETTING_ENTRIES, PAGE_LABEL } from '../src/lib/settingsIndex.ts';

const dict = (name) => JSON.parse(readFileSync(new URL(`../src/i18n/${name}.json`, import.meta.url), 'utf8'));
const en = dict('en');
const ru = dict('ru');
const tr = (d) => (k) => d[k] ?? en[k] ?? k;
const inEn = [tr(en)];
const inRu = [tr(ru), tr(en)];

test('finds a setting by title without knowing its page', () => {
  const hits = searchSettings('brave', inEn);
  assert.equal(hits[0].id, 'webBraveKey');
  assert.equal(hits[0].page, 'web');
  assert.equal(hits[0].detail, 'Web tools');
});

test('finds by description words and by page name', () => {
  assert.ok(
    searchSettings('screen recording', inEn).some((h) => h.id === 'permScreen') ||
      searchSettings('screen', inEn).some((h) => h.id === 'permScreen'),
  );
  assert.ok(searchSettings('storage', inEn).some((h) => h.id === 'cleanupAuto'));
});

test('title matches rank above description matches', () => {
  const hits = searchSettings('web', inEn);
  assert.ok(hits.length > 1);
  const titleIdx = hits.findIndex((h) => /web/i.test(h.title));
  const descOnly = hits.findIndex((h) => !/web/i.test(h.title));
  if (descOnly >= 0) assert.ok(titleIdx < descOnly);
});

test('works in Russian, and Russian users can still search English names', () => {
  assert.equal(searchSettings('язык', inRu)[0].id, 'language');
  assert.ok(searchSettings('brave', inRu).some((h) => h.id === 'webBraveKey'));
  assert.ok(searchSettings('домены', inRu).some((h) => h.id === 'webAllow'));
});

test('finds keyboard shortcuts by name and by key combination', () => {
  assert.ok(searchSettings('new chat', inEn).some((h) => h.id === 'shortcut-newChat' && h.keys));
  for (const q of ['cmd+n', 'cmd n', '⌘n', 'ctrl+n'])
    assert.ok(
      searchSettings(q, inEn).some((h) => h.id === 'shortcut-newChat'),
      q,
    );
  assert.ok(searchSettings('⌘⌥↵', inEn).some((h) => h.id === 'shortcut-sendNewChat'));
});

test('short queries and nonsense return nothing', () => {
  assert.deepEqual(searchSettings('', inEn), []);
  assert.deepEqual(searchSettings('a', inEn), []);
  assert.deepEqual(searchSettings('qzxwv', inEn), []);
});

test('every entry has text in both languages and a known page; ids are unique', () => {
  const ids = new Set();
  for (const e of SETTING_ENTRIES) {
    assert.ok(!ids.has(e.id), e.id);
    ids.add(e.id);
    for (const k of [e.title, e.desc, ...(e.keywords ?? [])].filter(Boolean))
      assert.ok(en[k] && ru[k], `${e.id}: ${k}`);
    assert.ok(PAGE_LABEL[e.page], e.id);
  }
});
