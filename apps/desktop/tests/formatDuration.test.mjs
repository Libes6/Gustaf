import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatDuration, formatDurationMs } from '../src/lib/formatDuration.ts';

const dict = Object.fromEntries(['en', 'ru'].map((l) => [l, JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url), 'utf8'))]));
const tFor = (l) => (key, vars) => dict[l][key].replace('{n}', vars.n);

const CASES = [
  [0, '0 s', '0 с'],
  [59, '59 s', '59 с'],
  [60, '1 min 0 s', '1 мин 0 с'],
  [61, '1 min 1 s', '1 мин 1 с'],
  [162, '2 min 42 s', '2 мин 42 с'],
  [3599, '59 min 59 s', '59 мин 59 с'],
  [3600, '1 h 0 min', '1 ч 0 мин'],
  [3661, '1 h 1 min', '1 ч 1 мин'],
  [5400, '1 h 30 min', '1 ч 30 мин'],
  [90_000, '25 h 0 min', '25 ч 0 мин'],
];

test('seconds, minutes and hours in English and Russian; seconds are dropped from the hour mark', () => {
  for (const [s, en, ru] of CASES) {
    assert.equal(formatDuration(s, tFor('en')), en, `en ${s}`);
    assert.equal(formatDuration(s, tFor('ru')), ru, `ru ${s}`);
  }
});

test('fractions are truncated, junk counts as zero', () => {
  assert.equal(formatDuration(59.99, tFor('en')), '59 s');
  assert.equal(formatDuration(-5, tFor('en')), '0 s');
  assert.equal(formatDuration(Number.NaN, tFor('en')), '0 s');
  assert.equal(formatDuration(Infinity, tFor('ru')), '0 с');
  assert.equal(formatDurationMs(162_999, tFor('en')), '2 min 42 s');
});

test('tenths only under a minute (never 60.0 s), the same units from a minute', () => {
  const en = tFor('en');
  assert.equal(formatDuration(0, en, { tenths: true }), '0.0 s');
  assert.equal(formatDuration(12.34, en, { tenths: true }), '12.3 s');
  assert.equal(formatDuration(0.3, en, { tenths: true }), '0.3 s');
  assert.equal(formatDuration(59.96, en, { tenths: true }), '59.9 s');
  assert.equal(formatDuration(60, en, { tenths: true }), '1 min 0 s');
  assert.equal(formatDuration(3661.7, tFor('ru'), { tenths: true }), '1 ч 1 мин');
  assert.equal(formatDurationMs(12_300, tFor('ru'), { tenths: true }), '12.3 с');
});
