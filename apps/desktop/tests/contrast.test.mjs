// Regression guard for WCAG contrast (1.4.3 text 4.5:1, 1.4.11 UI 3:1) of the tokens in src/styles/theme.css.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  accentVars,
  contrastRatio,
  focusRingColor,
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  MIN_TEXT_CONTRAST,
  MIN_UI_CONTRAST,
} from '../src/lib/themeUtil.ts';

const css = fs.readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');
const block = (sel) => {
  const i = css.indexOf(sel + ' {');
  assert.ok(i >= 0, `${sel} block missing`);
  return css.slice(i, css.indexOf('}', i));
};
const vars = (b) =>
  Object.fromEntries([...b.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1], m[2]]));
const dark = vars(block(':root'));
const themes = {
  dark: { ...dark, ...accentVars(DEFAULT_ACCENT, 'dark') },
  light: { ...dark, ...vars(block(':root[data-theme="light"]')), ...accentVars(DEFAULT_ACCENT, 'light') },
};

const SURFACES = ['--bg', '--bg-side', '--bg-elev', '--bg-input', '--bg-hover', '--bg-code'];
const TEXTS = [
  '--text',
  '--text-2',
  '--text-3',
  '--accent-soft',
  '--green',
  '--red',
  '--warn',
  '--error-fg',
  '--diff-add-fg',
  '--diff-del-fg',
  '--diff-hunk',
];
const CODE_TEXTS = ['--hl-comment', '--hl-keyword', '--hl-string', '--hl-number', '--hl-title', '--hl-type'];
const PAIRS = [
  ['--on-accent', '--accent-soft'],
  ['--bubble-fg', '--bubble'],
  ['--btn-primary-fg', '--btn-primary-bg'],
  ['--badge-fg', '--badge-bg'],
];

for (const [name, v] of Object.entries(themes)) {
  test(`${name}: text tokens reach ${MIN_TEXT_CONTRAST}:1 on the main surfaces`, () => {
    for (const fg of TEXTS)
      for (const bg of SURFACES) {
        assert.ok(v[fg] && v[bg], `${fg} / ${bg} defined`);
        const r = contrastRatio(v[fg], v[bg]);
        assert.ok(r >= MIN_TEXT_CONTRAST, `${name}: ${fg} ${v[fg]} on ${bg} ${v[bg]} is ${r.toFixed(2)}`);
      }
    for (const fg of CODE_TEXTS) {
      const r = contrastRatio(v[fg], v['--bg-code']);
      assert.ok(r >= MIN_TEXT_CONTRAST, `${name}: ${fg} on --bg-code is ${r.toFixed(2)}`);
    }
  });

  test(`${name}: paired foreground/background tokens`, () => {
    for (const [fg, bg] of PAIRS) {
      const r = contrastRatio(v[fg], v[bg]);
      assert.ok(r >= MIN_TEXT_CONTRAST, `${name}: ${fg} on ${bg} is ${r.toFixed(2)}`);
    }
  });

  test(`${name}: focus ring and switch track reach ${MIN_UI_CONTRAST}:1 against the page`, () => {
    assert.ok(contrastRatio(v['--focus'], v['--bg']) >= MIN_UI_CONTRAST);
    assert.ok(contrastRatio(v['--toggle-off'], v['--bg']) >= MIN_UI_CONTRAST, 'off switch track');
  });
}

test('focusRingColor keeps every preset and extreme accent visible in both themes', () => {
  for (const theme of ['dark', 'light']) {
    for (const accent of [...ACCENT_PRESETS, '#000000', '#ffffff', '#ffff00']) {
      const ring = focusRingColor(accent, theme);
      const bg = theme === 'dark' ? '#181818' : '#ffffff';
      assert.ok(contrastRatio(ring, bg) >= MIN_UI_CONTRAST, `${theme} ${accent} -> ${ring}`);
    }
  }
});
