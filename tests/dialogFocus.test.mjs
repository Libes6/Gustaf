import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapTarget, rovingTarget, FOCUSABLE } from '../src/lib/dialogFocus.ts';

test('trapTarget wraps Tab at the ends and leaves the middle to the browser', () => {
  assert.equal(trapTarget(3, 0, false), null);
  assert.equal(trapTarget(3, 1, false), null);
  assert.equal(trapTarget(3, 2, false), 0); // Tab on the last item -> first
  assert.equal(trapTarget(3, 0, true), 2); // Shift+Tab on the first -> last
  assert.equal(trapTarget(3, 1, true), null);
});

test('trapTarget pulls focus back in when it is outside the list', () => {
  assert.equal(trapTarget(3, -1, false), 0);
  assert.equal(trapTarget(3, -1, true), 2);
});

test('trapTarget with nothing focusable keeps focus on the dialog', () => {
  assert.equal(trapTarget(0, -1, false), -1);
  assert.equal(trapTarget(1, 0, false), 0);
  assert.equal(trapTarget(1, 0, true), 0);
});

test('rovingTarget moves with arrows, wraps, and supports Home/End', () => {
  assert.equal(rovingTarget('ArrowDown', 3, 0), 1);
  assert.equal(rovingTarget('ArrowDown', 3, 2), 0);
  assert.equal(rovingTarget('ArrowUp', 3, 0), 2);
  assert.equal(rovingTarget('ArrowUp', 3, 2), 1);
  assert.equal(rovingTarget('ArrowDown', 3, -1), 0);
  assert.equal(rovingTarget('ArrowUp', 3, -1), 2);
  assert.equal(rovingTarget('Home', 3, 2), 0);
  assert.equal(rovingTarget('End', 3, 0), 2);
  assert.equal(rovingTarget('a', 3, 0), null);
  assert.equal(rovingTarget('ArrowDown', 0, -1), null);
});

test('FOCUSABLE excludes disabled and tabindex=-1 elements', () => {
  assert.ok(FOCUSABLE.includes('button:not([disabled])'));
  assert.ok(FOCUSABLE.includes('[tabindex]:not([tabindex="-1"])'));
});
