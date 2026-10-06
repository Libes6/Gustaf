import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTheme, isThemeMode, normalizeHex, parsePrefs, contrastRatio, readableOn, darkenUntilReadable, accentVars,
  ACCENT_PRESETS, DEFAULT_ACCENT, DEFAULT_THEME, MIN_TEXT_CONTRAST, mix,
} from '../src/lib/themeUtil.ts';
import { SHORTCUTS, matches, matchesCombo, findConflicts, isTextEditingSafe, shortcut } from '../src/lib/shortcuts.ts';

test('resolveTheme: explicit modes ignore the OS, system follows it', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('isThemeMode / parsePrefs fall back on garbage', () => {
  assert.ok(isThemeMode('system') && !isThemeMode('auto') && !isThemeMode(undefined));
  assert.deepEqual(parsePrefs('light', '#FFF'), { mode: 'light', accent: '#ffffff' });
  assert.deepEqual(parsePrefs(42, 'red'), { mode: DEFAULT_THEME, accent: DEFAULT_ACCENT });
  assert.deepEqual(parsePrefs(null, null), { mode: DEFAULT_THEME, accent: DEFAULT_ACCENT });
});

test('normalizeHex accepts 3/6 digits with or without #, rejects the rest', () => {
  assert.equal(normalizeHex('#A884EE'), '#a884ee');
  assert.equal(normalizeHex(' a884ee '), '#a884ee');
  assert.equal(normalizeHex('#abc'), '#aabbcc');
  for (const bad of ['', '#', '#abcd', '#12345', '#gggggg', 'rgb(1,2,3)', '#a884ee00', null, 5]) assert.equal(normalizeHex(bad), null, String(bad));
});

test('contrastRatio matches the WCAG reference values', () => {
  assert.equal(contrastRatio('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
  assert.equal(contrastRatio('#ffffff', '#000000'), contrastRatio('#000000', '#ffffff'));
});

test('readableOn picks the readable text color', () => {
  assert.equal(readableOn('#ffffff'), '#1b1b1b');
  assert.equal(readableOn('#000000'), '#ffffff');
  assert.equal(readableOn('#f5c451'), '#1b1b1b');
});

test('darkenUntilReadable reaches the minimum contrast and leaves good colors alone', () => {
  assert.equal(darkenUntilReadable('#222222'), '#222222');
  const c = darkenUntilReadable('#f5c451');
  assert.ok(contrastRatio(c, '#ffffff') >= MIN_TEXT_CONTRAST);
});

test('accentVars: every preset gives readable text on bubble and soft accent in both themes', () => {
  for (const theme of ['light', 'dark']) {
    for (const accent of [...ACCENT_PRESETS, '#ffff00', '#000000', '#ffffff']) {
      const v = accentVars(accent, theme);
      assert.equal(v['--accent'], accent);
      assert.ok(contrastRatio(v['--bubble'], v['--bubble-fg']) >= MIN_TEXT_CONTRAST, `bubble ${theme} ${accent}`);
      assert.ok(contrastRatio(v['--accent-soft'], v['--on-accent']) >= MIN_TEXT_CONTRAST, `soft ${theme} ${accent}`);
    }
  }
  // soft accent is lighter than the accent on dark, darker on light
  assert.ok(contrastRatio(accentVars('#a884ee', 'dark')['--accent-soft'], '#000000') > contrastRatio('#a884ee', '#000000'));
  assert.notEqual(accentVars('#a884ee', 'light')['--accent-soft'], accentVars('#a884ee', 'dark')['--accent-soft']);
  assert.equal(accentVars('nonsense', 'dark')['--accent'], DEFAULT_ACCENT);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
});

const key = (key, mods = {}) => ({ key, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods });

test('shortcuts: matchers are exact about modifiers', () => {
  assert.ok(matches(key(',', { metaKey: true }), 'settings'));
  assert.ok(!matches(key(','), 'settings'));
  assert.ok(matches(key('n', { metaKey: true }), 'newChat'));
  assert.ok(matches(key('N', { metaKey: true }), 'newChat'));
  assert.ok(!matches(key('N', { metaKey: true, shiftKey: true }), 'newChat'));
  assert.ok(matches(key('k', { metaKey: true }), 'search'));
  assert.ok(matches(key('Escape'), 'closeSettings'));
  assert.ok(!matches(key('Escape', { metaKey: true, shiftKey: true }), 'closeSettings'));
  assert.ok(matches(key('Escape', { metaKey: true, shiftKey: true }), 'stopAgent'));
  assert.ok(matchesCombo(key('7', { metaKey: true }), 'Cmd+1-9') && !matchesCombo(key('0', { metaKey: true }), 'Cmd+1-9'));
  assert.ok(matchesCombo({ ...key('Dead'), code: 'KeyN', metaKey: true }, 'Cmd+N'));
});

test('shortcuts: no conflicts, no text-editing keys taken, global one has an accelerator', () => {
  assert.deepEqual(findConflicts(), []);
  assert.deepEqual(SHORTCUTS.filter((s) => !isTextEditingSafe(s)).map((s) => s.id), []);
  assert.equal(shortcut('stopAgent').accelerator, 'CommandOrControl+Shift+Escape');
  assert.deepEqual(findConflicts([...SHORTCUTS, { ...shortcut('settings'), id: 'newChat' }]).length > 0, true);
  assert.equal(isTextEditingSafe({ ...shortcut('settings'), combo: 'Cmd+V' }), false);
  assert.equal(isTextEditingSafe({ ...shortcut('settings'), combo: 'Enter' }), false);
  assert.equal(new Set(SHORTCUTS.map((s) => s.id)).size, SHORTCUTS.length);
});

test('chat width: parse falls back to standard, CSS values per setting', async () => {
  const { parseChatWidth, chatWidthCss, CHAT_WIDTHS } = await import('../src/lib/themeUtil.ts');
  assert.deepEqual(CHAT_WIDTHS, ['standard', 'wide', 'full']);
  assert.equal(parseChatWidth('wide'), 'wide');
  assert.equal(parseChatWidth('huge'), 'standard');
  assert.equal(parseChatWidth(undefined), 'standard');
  assert.deepEqual(CHAT_WIDTHS.map(chatWidthCss), ['720px', '960px', '100%']);
});
