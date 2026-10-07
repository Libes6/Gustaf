import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_PALETTES,
  emptyTheme,
  exportTheme,
  parseThemeFile,
  parseStoredThemes,
  themeCssVars,
  deriveFromBase,
  sanitizeThemeName,
  uniqueThemeId,
  duplicateName,
  TOKEN_KEYS,
  MAX_THEME_FILE_BYTES,
  exportFileName,
} from '../src/lib/customThemeUtil.ts';
import { contrastRatio } from '../src/lib/themeUtil.ts';

const sample = () => emptyTheme('mine', 'Mine');

test('export then import round-trips both palettes', () => {
  const t = sample();
  t.dark.bg = '#101820';
  t.light.text = '#222222';
  const r = parseThemeFile(exportTheme(t));
  assert.ok(r.ok);
  assert.equal(r.name, 'Mine');
  assert.deepEqual(r.dark, t.dark);
  assert.deepEqual(r.light, t.light);
  assert.equal(exportFileName(t), 'mine.gustaf-theme.json');
});

test('import accepts a partial palette and fills the rest from the built-in one', () => {
  const r = parseThemeFile(
    JSON.stringify({ format: 'gustaf-theme', version: 1, name: 'Tiny', dark: { bg: '#000', text: 'FFFFFF' } }),
  );
  assert.ok(r.ok);
  assert.equal(r.dark.bg, '#000000');
  assert.equal(r.dark.text, '#ffffff');
  assert.equal(r.dark.border, BASE_PALETTES.dark.border);
  assert.deepEqual(r.light, BASE_PALETTES.light);
});

test('import rejects bad input without throwing', () => {
  const ok = { format: 'gustaf-theme', version: 1, name: 'X', dark: { bg: '#000000' } };
  const err = (v) => {
    const r = parseThemeFile(typeof v === 'string' ? v : JSON.stringify(v));
    assert.equal(r.ok, false);
    return r.error;
  };
  assert.equal(err('not json {'), 'notJson');
  assert.equal(err('[]'), 'notTheme');
  assert.equal(err('null'), 'notTheme');
  assert.equal(err({ ...ok, format: 'other' }), 'notTheme');
  assert.equal(err({ ...ok, version: 2 }), 'version');
  assert.equal(err({ ...ok, extra: 1 }), 'unknownKey');
  assert.equal(err({ ...ok, name: '' }), 'name');
  assert.equal(err({ ...ok, name: '<script>' }), 'name');
  assert.equal(err({ ...ok, name: 'x'.repeat(41) }), 'name');
  assert.equal(err({ format: 'gustaf-theme', version: 1, name: 'X' }), 'noPalette');
  assert.equal(err({ ...ok, dark: { nope: '#000000' } }), 'unknownKey');
  assert.equal(err({ ...ok, dark: { __proto__x: '#000000' } }), 'unknownKey');
  for (const bad of [
    'red',
    'rgb(0,0,0)',
    'url(javascript:alert(1))',
    '#12345',
    '#00000000',
    'var(--x)',
    '#000; background: url(x)',
    5,
    null,
    {},
  ]) {
    assert.equal(err({ ...ok, dark: { bg: bad } }), 'badColor', String(bad));
  }
  assert.equal(err('{"format":"gustaf-theme","version":1,"name":"X","dark":{"__proto__":"#000000"}}'), 'unknownKey');
  assert.equal(err('x'.repeat(MAX_THEME_FILE_BYTES + 1)), 'tooLarge');
  assert.equal(err({ ...ok, dark: 'nope' }), 'notTheme');
});

test('imported colours are normalized hex only, so CSS variables cannot carry anything else', () => {
  const r = parseThemeFile(exportTheme(sample()));
  assert.ok(r.ok);
  for (const mode of ['light', 'dark']) {
    for (const v of Object.values(themeCssVars({ id: 'a', name: 'a', light: r.light, dark: r.dark }, mode)))
      assert.match(v, /^#[0-9a-f]{6}$/);
  }
});

test('parseStoredThemes drops invalid entries and duplicate ids', () => {
  const stored = [
    sample(),
    sample(),
    { id: '../x', name: 'Bad id' },
    { id: 'ok', name: '<b>' },
    null,
    'x',
    { id: 'good', name: 'Good', dark: { bg: 'zzz', text: '#fff' } },
  ];
  const out = parseStoredThemes(stored);
  assert.deepEqual(
    out.map((t) => t.id),
    ['mine', 'good'],
  );
  assert.equal(out[1].dark.bg, BASE_PALETTES.dark.bg);
  assert.equal(out[1].dark.text, '#ffffff');
  assert.deepEqual(parseStoredThemes('nope'), []);
  assert.equal(parseStoredThemes(Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, name: `T${i}` }))).length, 20);
});

test('names, ids and duplicate names', () => {
  assert.equal(sanitizeThemeName('  My   theme (2) '), 'My theme (2)');
  assert.equal(sanitizeThemeName('a/b'), null);
  assert.equal(uniqueThemeId('My Theme', []), 'my-theme');
  assert.equal(uniqueThemeId('My Theme', ['my-theme', 'my-theme-2']), 'my-theme-3');
  assert.equal(uniqueThemeId('!!!', []), 'theme');
  assert.equal(duplicateName('Mine', ['Mine']), 'Mine copy');
  assert.equal(duplicateName('Mine', ['Mine', 'Mine copy']), 'Mine copy 2');
});

test('simple mode derives every neutral token and keeps text readable', () => {
  const d = deriveFromBase('#101820', '#e8e8e8', true);
  for (const k of ['bgSide', 'bgElev', 'bgCode', 'border', 'text2', 'text3']) assert.match(d[k], /^#[0-9a-f]{6}$/, k);
  assert.ok(contrastRatio(d.text2, d.bg) >= 4.5);
  assert.ok(contrastRatio(d.text3, d.bg) >= 3);
  const l = deriveFromBase('#fafaf5', '#202020', false);
  assert.ok(contrastRatio(l.text3, l.bg) >= 4.5);
});

test('every token has a built-in value in both palettes', () => {
  for (const k of TOKEN_KEYS)
    for (const m of ['light', 'dark']) assert.match(BASE_PALETTES[m][k], /^#[0-9a-f]{6}$/, `${m}.${k}`);
});
