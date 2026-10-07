import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAppearance,
  appearanceVars,
  sanitizeFontName,
  fontStack,
  isDefaultAppearance,
  DEFAULT_APPEARANCE,
} from '../src/lib/appearanceUtil.ts';

test('parseAppearance falls back on garbage and clamps sizes', () => {
  assert.deepEqual(parseAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(parseAppearance('x'), DEFAULT_APPEARANCE);
  const p = parseAppearance({ uiSize: 99, codeSize: 1, wrapCode: 'yes', motion: 'warp', uiFont: { preset: 'nope' } });
  assert.equal(p.uiSize, 18);
  assert.equal(p.codeSize, 10);
  assert.equal(p.wrapCode, false);
  assert.equal(p.motion, 'normal');
  assert.equal(p.uiFont.preset, 'default');
  assert.equal(parseAppearance({ uiSize: '15' }).uiSize, 15);
});

test('custom font names are sanitized, unsafe ones rejected', () => {
  assert.equal(sanitizeFontName('  Fira   Code '), 'Fira Code');
  assert.equal(sanitizeFontName('Inter-Var_2.0'), 'Inter-Var_2.0');
  for (const bad of ['', 'a;b', 'a"b', "a'b", 'a{b}', 'url(x)', 'x'.repeat(61), 5, null])
    assert.equal(sanitizeFontName(bad), null, String(bad));
  assert.equal(parseAppearance({ codeFont: { preset: 'custom', custom: 'a;b' } }).codeFont.preset, 'default');
  assert.equal(fontStack({ preset: 'custom', custom: 'Fira Code' }, 'code').startsWith('"Fira Code", '), true);
});

test('appearanceVars scale relative to the defaults', () => {
  assert.equal(appearanceVars(DEFAULT_APPEARANCE)['--ui-scale'], '1');
  assert.equal(appearanceVars(DEFAULT_APPEARANCE)['--code-scale'], '1');
  assert.equal(appearanceVars(DEFAULT_APPEARANCE)['--motion'], '1');
  const v = appearanceVars(parseAppearance({ uiSize: 16, codeSize: 15, motion: 'off' }));
  assert.equal(v['--ui-scale'], String(+(16 / 13).toFixed(4)));
  assert.equal(v['--code-scale'], '1.25');
  assert.equal(v['--motion'], '0');
});

test('isDefaultAppearance', () => {
  assert.ok(isDefaultAppearance(parseAppearance(null)));
  assert.ok(!isDefaultAppearance(parseAppearance({ wrapCode: true })));
});
