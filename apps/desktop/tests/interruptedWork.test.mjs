import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInterruptedWork, linkedTaskIds } from '../src/lib/interruptedWork.ts';

const wt = (over = {}) => ({
  taskId: 'w1',
  path: '/data/w1',
  branch: 'gustaf/a',
  baseCommit: 'aaa',
  baseBranch: 'dev',
  createdAt: 10,
  provider: 'claude',
  model: 'opus',
  headSha: 'aaa',
  changedFiles: 0,
  ahead: 0,
  behind: 0,
  dirty: false,
  existsOnDisk: true,
  ...over,
});

test('a clean worktree level with its base is not interrupted work', () => {
  assert.deepEqual(findInterruptedWork([wt()], new Set()), []);
  assert.deepEqual(findInterruptedWork(undefined, new Set()), []);
});

test('dirty files and unmerged commits are listed with their counts', () => {
  const r = findInterruptedWork(
    [wt({ taskId: 'd', changedFiles: 3, dirty: true }), wt({ taskId: 'c', ahead: 2, headSha: 'bbb' })],
    new Set(),
  );
  assert.deepEqual(r.map((x) => [x.taskId, x.files, x.commits]).sort(), [
    ['c', 0, 2],
    ['d', 3, 0],
  ]);
});

test('worktrees owned by a chat or missing on disk are skipped', () => {
  const list = [
    wt({ taskId: 'owned', changedFiles: 1, dirty: true }),
    wt({ taskId: 'gone', changedFiles: 1, dirty: true, existsOnDisk: false }),
    wt({ taskId: 'free', ahead: 1 }),
  ];
  assert.deepEqual(
    findInterruptedWork(list, new Set(['owned'])).map((x) => x.taskId),
    ['free'],
  );
});

test('without a base branch a moved head counts as commits of unknown number', () => {
  const [r] = findInterruptedWork([wt({ ahead: null, headSha: 'bbb' })], new Set());
  assert.equal(r.commits, null);
  assert.deepEqual(findInterruptedWork([wt({ ahead: null, headSha: 'aaa' })], new Set()), []);
});

test('dirty without a file count still reports one file; newest first', () => {
  const r = findInterruptedWork(
    [wt({ taskId: 'old', dirty: true, createdAt: 1 }), wt({ taskId: 'new', ahead: 1, createdAt: 5 })],
    new Set(),
  );
  assert.deepEqual(
    r.map((x) => x.taskId),
    ['new', 'old'],
  );
  assert.equal(r[1].files, 1);
});

test('linkedTaskIds collects the workspace ids of chats', () => {
  assert.deepEqual(
    [...linkedTaskIds([{ workspace_task_id: 'a' }, { workspace_task_id: null }, {}, { workspace_task_id: 'b' }])],
    ['a', 'b'],
  );
});
