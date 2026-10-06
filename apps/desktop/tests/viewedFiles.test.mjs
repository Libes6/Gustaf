import { test } from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
const { isViewed, setViewed } = await import('../src/lib/viewedFiles.ts');

test('a viewed mark holds while the change is the same and drops when it differs', () => {
  setViewed('/p', 'a.ts', '3/1', true);
  assert.equal(isViewed('/p', 'a.ts', '3/1'), true);
  assert.equal(isViewed('/p', 'a.ts', '4/1'), false, 'the file changed again');
  assert.equal(isViewed('/q', 'a.ts', '3/1'), false, 'per project');
  setViewed('/p', 'a.ts', '3/1', false);
  assert.equal(isViewed('/p', 'a.ts', '3/1'), false);
});
