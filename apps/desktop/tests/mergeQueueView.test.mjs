import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONFLICT_CHECK_MS,
  STRATEGIES,
  conflictBadge,
  conflictKindKey,
  currentBatch,
  errorView,
  haltingItem,
  hasUnfinished,
  mergeStrategyKey,
  moveItem,
  normalizeStrategy,
  orderedSelection,
  recentResults,
  resolveDraft,
  shouldCheckConflicts,
  statusKey,
  statusTone,
  summarizeQueue,
  takesPartInConflictCheck,
  toggleInOrder,
} from '../src/lib/mergeQueueView.ts';
import { MERGE_QUEUE_ERROR_CODES } from '../src/lib/mergeQueue.ts';

const en = JSON.parse(readFileSync(new URL('../src/i18n/en.json', import.meta.url), 'utf8'));
const ru = JSON.parse(readFileSync(new URL('../src/i18n/ru.json', import.meta.url), 'utf8'));
const t = (key, vars = {}) => (en[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));

const item = (taskId, status, over = {}) => ({
  taskId,
  branch: `gustaf/${taskId}`,
  status,
  error: null,
  conflicts: [],
  strategy: 'merge',
  testCommand: null,
  targetBranch: 'main',
  enqueuedAt: 1,
  startedAt: null,
  finishedAt: null,
  ...over,
});
const state = (items, halted = false) => ({ version: 1, halted, items, updatedAt: 1 });

test('every status, strategy and conflict kind has a label in both languages', () => {
  for (const s of ['queued', 'rebasing', 'testing', 'merging', 'merged', 'failed', 'skipped']) {
    assert.ok(en[statusKey(s)], statusKey(s));
    assert.ok(ru[statusKey(s)], statusKey(s));
  }
  for (const k of ['content', 'add_add', 'modify_delete', 'other'])
    assert.ok(en[conflictKindKey(k)] && ru[conflictKindKey(k)], k);
  assert.equal(conflictKindKey('other'), 'mqKindOther');
  for (const s of STRATEGIES) assert.ok(en[`mqStrategy_${s}`] && en[`mqStrategyHint_${s}`] && ru[`mqStrategy_${s}`], s);
});

test('status tones group the statuses', () => {
  assert.deepEqual(['queued', 'rebasing', 'testing', 'merging', 'merged', 'failed', 'skipped'].map(statusTone), [
    'pending',
    'active',
    'active',
    'active',
    'ok',
    'fail',
    'skipped',
  ]);
});

test('strategy: unknown values fall back to merge, the key is per project', () => {
  assert.equal(normalizeStrategy('squash'), 'squash');
  assert.equal(normalizeStrategy('fast_forward'), 'fast_forward');
  assert.equal(normalizeStrategy('rebase'), 'merge');
  assert.equal(normalizeStrategy(null), 'merge');
  assert.equal(mergeStrategyKey('/work/a'), 'mergeStrategy:/work/a');
});

test('ordering: move, toggle and the ordered selection', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], -1, 0), ['a', 'b']);
  const input = ['a', 'b'];
  moveItem(input, 0, 1);
  assert.deepEqual(input, ['a', 'b'], 'the input is not changed');
  assert.deepEqual(orderedSelection(['c', 'a', 'b'], new Set(['b', 'c'])), ['c', 'b']);
  assert.deepEqual(orderedSelection(['a'], new Set(['a', 'z'])), ['a', 'z']);
  const added = toggleInOrder(['a'], new Set(), 'b');
  assert.deepEqual(added.order, ['a', 'b']);
  assert.deepEqual([...added.checked], ['b']);
  assert.deepEqual([...toggleInOrder(added.order, added.checked, 'b').checked], []);
});

test('queue summary, batch and halt', () => {
  const s = state(
    [
      item('a', 'merged', { finishedAt: 5, enqueuedAt: 1 }),
      item('b', 'failed', { finishedAt: 6, enqueuedAt: 2 }),
      item('c', 'queued', { enqueuedAt: 2 }),
    ],
    true,
  );
  assert.deepEqual(summarizeQueue(s), {
    total: 3,
    queued: 1,
    running: 0,
    merged: 1,
    failed: 1,
    skipped: 0,
    done: false,
  });
  assert.ok(hasUnfinished(s));
  assert.equal(haltingItem(s).taskId, 'b');
  assert.equal(haltingItem(state(s.items, false)), null);
  assert.equal(summarizeQueue(state([item('a', 'merged')])).done, true);
  assert.equal(summarizeQueue(null).done, false);
});

test('currentBatch leaves out old history but keeps what was started together', () => {
  const old = item('old', 'merged', { enqueuedAt: 1, finishedAt: 2 });
  const done = item('done', 'merged', { enqueuedAt: 10, finishedAt: 12 });
  const open = item('open', 'queued', { enqueuedAt: 10 });
  assert.deepEqual(
    currentBatch(state([old, done, open])).map((i) => i.taskId),
    ['done', 'open'],
  );
  // nothing unfinished: only what this dialog started
  assert.deepEqual(
    currentBatch(state([old, done]), ['done']).map((i) => i.taskId),
    ['done'],
  );
  assert.deepEqual(
    currentBatch(state([old, done])).map((i) => i.taskId),
    [],
  );
  assert.deepEqual(
    recentResults(state([old, done])).map((i) => i.taskId),
    ['done', 'old'],
  );
});

test('errors map to plain messages with the fix and say if a retry makes sense', () => {
  for (const code of ['target_dirty', 'target_not_checked_out', 'queue_busy']) {
    const v = errorView(`${code}: details`);
    assert.equal(v.retryable, true, code);
    assert.ok(en[v.key] && ru[v.key], code);
  }
  for (const code of [
    'dirty',
    'already_queued',
    'not_found',
    'git_too_old',
    'invalid_strategy',
    'not_a_git_repo',
    'no_commits',
  ]) {
    const v = errorView(`${code}: details`);
    assert.equal(v.retryable, false, code);
    assert.notEqual(v.key, 'mqErrGeneric', code);
  }
  assert.match(
    t(errorView('target_dirty: 2 uncommitted change(s)').key, errorView('target_dirty: 2 uncommitted change(s)').vars),
    /Commit or stash them there.*Try again.*2 uncommitted/,
  );
  assert.match(t('mqErr_target_not_checked_out', { detail: 'on dev' }), /Switch it to that branch/);
  const generic = errorView('git_error: boom');
  assert.equal(generic.key, 'mqErrGeneric');
  assert.deepEqual(generic.vars, { detail: 'boom', code: 'git_error' });
  assert.equal(errorView(new Error('weird')).key, 'mqErrGeneric');
  // every backend code is handled or deliberately generic, and every message key exists in both languages
  for (const code of MERGE_QUEUE_ERROR_CODES) {
    const v = errorView(`${code}: x`);
    assert.ok(en[v.key] && ru[v.key], code);
  }
});

test('conflict badge: the target first, then the other workspaces; clean gives nothing', () => {
  const clean = { againstTaskId: null, against: 'main', clean: true, conflicts: [], truncated: false };
  assert.equal(conflictBadge(null), null);
  assert.equal(conflictBadge({ taskId: 'a', branch: 'x', target: 'main', clean: true, checks: [clean] }), null);
  const other = {
    againstTaskId: 't2',
    against: 'gustaf/two',
    clean: false,
    conflicts: [{ path: 'a.ts', kind: 'content' }],
    truncated: false,
  };
  const onTarget = {
    againstTaskId: null,
    against: 'main',
    clean: false,
    conflicts: [
      { path: 'a.ts', kind: 'content' },
      { path: 'b.ts', kind: 'add_add' },
    ],
    truncated: false,
  };
  const b = conflictBadge({ taskId: 'a', branch: 'x', target: 'main', clean: false, checks: [onTarget, other] });
  assert.equal(b.against, 'main');
  assert.equal(b.target, true);
  assert.equal(b.files, 2);
  assert.equal(b.more, 1);
  assert.equal(t('mqBadge', { against: b.against, count: b.files }), 'Conflicts with main (2 files)');
  const w = conflictBadge({ taskId: 'a', branch: 'x', target: 'main', clean: false, checks: [clean, other] });
  assert.equal(w.against, 'gustaf/two');
  assert.equal(w.againstTaskId, 't2');
  assert.equal(w.target, false);
  assert.equal(w.more, 0);
  assert.equal(w.groups.length, 1);
});

test('conflict checks are throttled to 30 s, re-run when the set of workspaces changes, and skip level branches', () => {
  assert.equal(CONFLICT_CHECK_MS, 30_000);
  const base = { lastAt: 1000, lastSignature: 'b', signature: 'b', now: 1000 + 29_999 };
  assert.equal(shouldCheckConflicts(base), false);
  assert.equal(shouldCheckConflicts({ ...base, now: 1000 + 30_000 }), true);
  assert.equal(shouldCheckConflicts({ ...base, lastAt: null }), true);
  assert.equal(shouldCheckConflicts({ ...base, signature: 'b,c' }), true);
  assert.equal(shouldCheckConflicts({ ...base, force: true }), true);
  assert.equal(takesPartInConflictCheck({ existsOnDisk: true, ahead: 2 }), true);
  assert.equal(takesPartInConflictCheck({ existsOnDisk: true, ahead: null }), true);
  assert.equal(takesPartInConflictCheck({ existsOnDisk: true, ahead: 0 }), false);
  assert.equal(takesPartInConflictCheck({ existsOnDisk: false, ahead: 3 }), false);
});

test('the resolve draft names the target, lists the files and tells the agent not to push', () => {
  const files = [
    { path: 'src/a.ts', kind: 'content' },
    { path: 'b.txt', kind: 'modify_delete' },
  ];
  const text = resolveDraft({ target: 'main', files, testCommand: ' npm test ', t });
  assert.match(
    text,
    /^Merging this branch into main failed with conflicts in these files:\n- src\/a\.ts \(content\)\n- b\.txt \(changed and deleted\)\n/,
  );
  assert.match(text, /keeping both intents/);
  assert.match(text, /run `npm test` to check the result/);
  assert.match(text, /commit the result\. Do not push\.$/);
  assert.match(resolveDraft({ target: 'main', files, testCommand: null, t }), /run the project's tests if it has any/);
  const ruText = resolveDraft({
    target: 'main',
    files,
    testCommand: 'npm test',
    t: (k, v = {}) => (ru[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => String(v[x] ?? '')),
  });
  assert.match(ruText, /Не отправляйте/);
});
