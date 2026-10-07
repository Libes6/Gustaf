import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupDue, DAY_MS, logDay, parseCleanup, planWorkspaces, staleWorkspaces } from '../src/lib/cleanupCore.ts';

const NOW = Date.UTC(2026, 9, 6);
const info = (taskId, o = {}) => ({
  taskId,
  branch: `gustaf/${taskId}`,
  path: `/data/worktrees/${taskId}`,
  existsOnDisk: true,
  dirty: false,
  createdAt: (NOW - 90 * DAY_MS) / 1000,
  ...o,
});
const chat = (id, taskId, ageDays) => ({ id, workspace_task_id: taskId, updated_at: NOW - ageDays * DAY_MS });

test('parseCleanup: off by default, days clamped', () => {
  assert.deepEqual(parseCleanup(null), { enabled: false, days: 14, logsEnabled: false, logsDays: 14 });
  assert.deepEqual(parseCleanup({ enabled: true, days: 0 }), {
    enabled: true,
    days: 1,
    logsEnabled: false,
    logsDays: 14,
  });
  assert.deepEqual(parseCleanup({ enabled: 'yes', days: 'x', logsEnabled: 1 }), {
    enabled: false,
    days: 14,
    logsEnabled: false,
    logsDays: 14,
  });
});

test('staleWorkspaces: only idle, clean, existing checkouts of workspace chats', () => {
  const chats = [
    chat(1, 'a', 30),
    chat(2, 'b', 30),
    chat(3, 'c', 30),
    chat(4, 'd', 3),
    chat(5, null, 99),
    chat(6, 'gone', 30),
    chat(7, 'e', 30),
  ];
  const infos = [
    info('a'),
    info('b', { dirty: true }),
    info('c', { existsOnDisk: false }),
    info('d'),
    info('e', { createdAt: (NOW - DAY_MS) / 1000 }),
  ];
  assert.deepEqual(staleWorkspaces(chats, infos, NOW, 14), [
    { chatId: 1, taskId: 'a', branch: 'gustaf/a', path: '/data/worktrees/a' },
  ]);
});

test('cleanupDue: once a day, and a clock set back counts as due', () => {
  assert.equal(cleanupDue(0, NOW), true);
  assert.equal(cleanupDue(NOW - 3600_000, NOW), false);
  assert.equal(cleanupDue(NOW - DAY_MS, NOW), true);
  assert.equal(cleanupDue(NOW + 1000, NOW), true);
});

test('the two periods are independent: changing one never changes the other', () => {
  const both = parseCleanup({ enabled: true, days: 30, logsEnabled: true, logsDays: 3 });
  assert.deepEqual(both, { enabled: true, days: 30, logsEnabled: true, logsDays: 3 });
  assert.deepEqual(parseCleanup({ ...both, enabled: false }), {
    enabled: false,
    days: 30,
    logsEnabled: true,
    logsDays: 3,
  });
  assert.deepEqual(parseCleanup({ ...both, logsDays: 400 }), {
    enabled: true,
    days: 30,
    logsEnabled: true,
    logsDays: 365,
  });
});

test('an old save with only the workspace policy keeps it and leaves the log policy off', () => {
  assert.deepEqual(parseCleanup({ enabled: true, days: 30 }), {
    enabled: true,
    days: 30,
    logsEnabled: false,
    logsDays: 14,
  });
});

test('planWorkspaces: a dirty idle worktree is protected and only reported', () => {
  const plan = planWorkspaces([chat(1, 'a', 30), chat(2, 'b', 30)], [info('a'), info('b', { dirty: true })], NOW, 14);
  assert.deepEqual(
    plan.remove.map((t) => t.taskId),
    ['a'],
  );
  assert.deepEqual(
    plan.keptDirty.map((t) => t.taskId),
    ['b'],
  );
});

test('planWorkspaces: a plan never carries a branch deletion, chats are only referenced', () => {
  const plan = planWorkspaces([chat(1, 'a', 30)], [info('a')], NOW, 14);
  assert.deepEqual(Object.keys(plan.remove[0]).sort(), ['branch', 'chatId', 'path', 'taskId']);
});

test('logDay: local YYYY-MM-DD with zero padding', () => {
  assert.equal(logDay(new Date(2026, 0, 5, 12).getTime()), '2026-01-05');
  assert.equal(logDay(new Date(2026, 9, 7, 23, 59).getTime()), '2026-10-07');
});
