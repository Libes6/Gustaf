// The shared settings row must wrap its control under the text on a narrow window (no media query: flex-wrap + a text basis).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

test('setting row wraps and keeps the text readable', () => {
  assert.match(css, /\.card-row\.setting-row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.setting-row > \.setting-text\s*\{[^}]*flex:\s*1 1 \d+px[^}]*min-width:\s*0/);
  assert.match(css, /\.setting-row > \.setting-control\s*\{[^}]*max-width:\s*100%/);
});
