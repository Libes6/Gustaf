import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupDue, DAY_MS, parseCleanup, staleWorkspaces } from '../src/lib/cleanupCore.ts';

const NOW = Date.UTC(2026, 9, 6);
const info = (taskId, o = {}) => ({ taskId, existsOnDisk: true, dirty: false, createdAt: (NOW - 90 * DAY_MS) / 1000, ...o });
const chat = (id, taskId, ageDays) => ({ id, workspace_task_id: taskId, updated_at: NOW - ageDays * DAY_MS });

test('parseCleanup: off by default, days clamped', () => {
  assert.deepEqual(parseCleanup(null), { enabled: false, days: 14 });
  assert.deepEqual(parseCleanup({ enabled: true, days: 0 }), { enabled: true, days: 1 });
  assert.deepEqual(parseCleanup({ enabled: 'yes', days: 'x' }), { enabled: false, days: 14 });
});

test('staleWorkspaces: only idle, clean, existing checkouts of workspace chats', () => {
  const chats = [chat(1, 'a', 30), chat(2, 'b', 30), chat(3, 'c', 30), chat(4, 'd', 3), chat(5, null, 99), chat(6, 'gone', 30), chat(7, 'e', 30)];
  const infos = [info('a'), info('b', { dirty: true }), info('c', { existsOnDisk: false }), info('d'), info('e', { createdAt: (NOW - DAY_MS) / 1000 })];
  assert.deepEqual(staleWorkspaces(chats, infos, NOW, 14), [{ chatId: 1, taskId: 'a' }]);
});

test('cleanupDue: once a day, and a clock set back counts as due', () => {
  assert.equal(cleanupDue(0, NOW), true);
  assert.equal(cleanupDue(NOW - 3600_000, NOW), false);
  assert.equal(cleanupDue(NOW - DAY_MS, NOW), true);
  assert.equal(cleanupDue(NOW + 1000, NOW), true);
});
