import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const { savedPosition, savePosition } = await import('../src/lib/readingPosition.ts');

test('a position away from the end is kept per chat; at the end it is forgotten', () => {
  savePosition(5, 1200);
  assert.equal(savedPosition(5), 1200);
  savePosition(5, 10);
  assert.equal(savedPosition(5), null);
  assert.equal(savedPosition(6), null);
  for (let i = 1; i <= 250; i++) savePosition(1000 + i, 500);
  assert.equal(Object.keys(JSON.parse(mem.get('gustaf-reading'))).length, 200);
});
