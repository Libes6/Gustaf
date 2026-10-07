import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allPassed,
  diffSnapshots,
  MAX_COMMENT_WAKES,
  parseSnapshot,
  step,
  UNREADABLE_MS,
  wakeMessage,
} from '../src/lib/prWatchCore.ts';

const snap = (over = {}) => ({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  title: 'Fix',
  url: 'https://github.com/o/r/pull/7',
  number: 7,
  author: 'me',
  checks: [],
  comments: [],
  reviews: [],
  ...over,
});
const check = (name, status, conclusion) => ({ name, status, conclusion });

test('parseSnapshot tolerates missing fields', () => {
  const s = parseSnapshot('{"state":"OPEN","number":"7","checks":[{"name":"ci"}],"comments":null}');
  assert.equal(s.number, 7);
  assert.deepEqual(s.checks, [{ name: 'ci', status: '', conclusion: '' }]);
  assert.deepEqual(s.comments, []);
});

test('each change is reported once; own comments are ignored', () => {
  const a = snap({ checks: [check('ci', 'IN_PROGRESS', '')] });
  const b = snap({
    checks: [check('ci', 'COMPLETED', 'FAILURE')],
    comments: [
      { id: 'c1', author: 'me' },
      { id: 'c2', author: 'rev' },
    ],
  });
  assert.deepEqual(diffSnapshots(a, b), [
    { kind: 'checks-failed', names: ['ci'] },
    { kind: 'comment', authors: ['rev'], count: 1 },
  ]);
  assert.deepEqual(diffSnapshots(b, b), []);
  const fixed = snap({ checks: [check('ci', 'COMPLETED', 'SUCCESS')], comments: b.comments });
  assert.ok(allPassed(fixed));
  assert.deepEqual(diffSnapshots(b, fixed), [{ kind: 'checks-passed' }]);
  assert.deepEqual(diffSnapshots(fixed, snap({ ...fixed, mergeable: 'CONFLICTING' })), [{ kind: 'conflict' }]);
  assert.deepEqual(diffSnapshots(fixed, snap({ ...fixed, state: 'MERGED' })), [{ kind: 'merged' }]);
  assert.deepEqual(diffSnapshots(undefined, b), [], 'the first snapshot is the baseline');
});

test('step stops on merge, on 10 comment-only wakes and after 15 unreadable minutes', () => {
  const w = { chatId: 1, root: '/r', pr: '7', startedAt: 0, okAt: 0, commentWakes: 0 };
  const first = step(w, { ok: true, snapshot: snap() }, 1);
  assert.equal(first.events.length, 0);
  assert.equal(step(first.watch, { ok: true, snapshot: snap({ state: 'MERGED' }) }, 2).watch.stopped.reason, 'merged');
  let cur = first.watch;
  for (let i = 0; i < MAX_COMMENT_WAKES; i++)
    cur = step(
      cur,
      { ok: true, snapshot: snap({ comments: [...cur.last.comments, { id: `x${i}`, author: 'rev' }] }) },
      10 + i,
    ).watch;
  assert.equal(cur.stopped.reason, 'comments');
  const failing = step(first.watch, { ok: false, error: 'offline' }, UNREADABLE_MS - 10);
  assert.equal(failing.watch.stopped, undefined);
  assert.equal(
    step(first.watch, { ok: false, error: 'offline' }, UNREADABLE_MS + 5).watch.stopped.reason,
    'unreadable',
  );
  assert.equal(
    step(w, { ok: true, snapshot: snap({ state: 'CLOSED' }) }, 3).watch.stopped.reason,
    'closed',
    'already closed when watching starts',
  );
});

test('wakeMessage names the PR and what to do', () => {
  const m = wakeMessage(snap(), [
    { kind: 'checks-failed', names: ['lint'] },
    { kind: 'review', authors: ['ann'], states: ['CHANGES_REQUESTED'] },
  ]);
  assert.match(m, /pull\/7/);
  assert.match(m, /Checks failed: lint/);
  assert.match(m, /ann \(CHANGES_REQUESTED\)/);
});
