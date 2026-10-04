import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MERGE_QUEUE_ERROR_CODES, MergeQueueError, isRetryableTargetError, isTerminalStatus, nextQueueItem, parseMergeQueueError,
} from '../src/lib/mergeQueue.ts';

test('every backend error code maps to a typed error', () => {
  for (const code of MERGE_QUEUE_ERROR_CODES) {
    const e = parseMergeQueueError(`${code}: something happened`);
    assert.ok(e instanceof MergeQueueError);
    assert.equal(e.code, code);
    assert.equal(e.message, 'something happened');
  }
});

test('the error codes cover what the Rust module can return', () => {
  const rust = readFileSync(new URL('../src-tauri/src/merge_queue.rs', import.meta.url), 'utf8');
  const used = new Set([...rust.matchAll(/err\("([a-z_]+)"/g)].map((m) => m[1]));
  for (const code of used) assert.ok(MERGE_QUEUE_ERROR_CODES.includes(code), `${code} is missing from MERGE_QUEUE_ERROR_CODES`);
  // codes returned by worktree.rs helpers (open_repo, read_meta, safe_existing_dir)
  for (const code of ['not_a_git_repo', 'bare_repo', 'invalid_root', 'unsafe_path', 'invalid_task_id', 'not_found']) {
    assert.ok(MERGE_QUEUE_ERROR_CODES.includes(code), code);
  }
});

test('multi-line messages and Error objects are kept', () => {
  assert.equal(parseMergeQueueError('target_dirty: 2 changes\nsecond line').message, '2 changes\nsecond line');
  assert.equal(parseMergeQueueError(new Error('git_too_old: git 2.30')).code, 'git_too_old');
});

test('unknown shapes become git_error with the original text', () => {
  for (const raw of ['fatal: boom', 'weird_code: x', 'Not_A: x', '', 42, null, { a: 1 }]) {
    const e = parseMergeQueueError(raw);
    assert.equal(e.code, 'git_error');
    assert.equal(e.message, String(raw));
  }
});

test('an existing MergeQueueError passes through', () => {
  const e = new MergeQueueError('queue_busy', 'x');
  assert.equal(parseMergeQueueError(e), e);
});

test('retryable target errors are those that leave the item queued', () => {
  for (const code of ['target_dirty', 'target_not_checked_out', 'queue_busy']) assert.equal(isRetryableTargetError(`${code}: x`), true);
  for (const code of ['dirty', 'not_found', 'git_too_old', 'state_error']) assert.equal(isRetryableTargetError(`${code}: x`), false);
  assert.equal(isRetryableTargetError('boom'), false);
});

test('terminal statuses and the next item', () => {
  for (const s of ['merged', 'failed', 'skipped']) assert.equal(isTerminalStatus(s), true);
  for (const s of ['queued', 'rebasing', 'testing', 'merging']) assert.equal(isTerminalStatus(s), false);
  const item = (taskId, status) => ({ taskId, status });
  assert.equal(nextQueueItem({ items: [] }), null);
  assert.equal(nextQueueItem({ items: [item('a', 'merged'), item('b', 'failed')] }), null);
  assert.equal(nextQueueItem({ items: [item('a', 'merged'), item('b', 'testing'), item('c', 'queued')] }).taskId, 'b');
});

test('the wrapper invokes the registered command names', () => {
  const ts = readFileSync(new URL('../src/lib/mergeQueue.ts', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const commands = [...ts.matchAll(/call<[^>]+>\("([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(commands.sort(), ['conflicts_check', 'queue_cancel', 'queue_enqueue', 'queue_report_test', 'queue_resume', 'queue_run_next', 'queue_status']);
  for (const c of commands) assert.ok(lib.includes(`merge_queue::${c}`), `${c} is not registered in lib.rs`);
});
