import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORKTREE_ERROR_CODES, WorktreeError, needsShadowCopyFallback, parseWorktreeError } from '../src/lib/worktrees.ts';

test('every backend error code maps to a typed error', () => {
  for (const code of WORKTREE_ERROR_CODES) {
    const e = parseWorktreeError(`${code}: something happened`);
    assert.ok(e instanceof WorktreeError);
    assert.equal(e.code, code);
    assert.equal(e.message, 'something happened');
  }
});

test('multi-line messages and Error objects are kept', () => {
  assert.equal(parseWorktreeError('dirty: 2 changes\nsecond line').message, '2 changes\nsecond line');
  assert.equal(parseWorktreeError(new Error('not_a_git_repo: nope')).code, 'not_a_git_repo');
});

test('unknown shapes become git_error with the original text', () => {
  for (const raw of ['fatal: boom', 'weird_code: x', 'Not_A: x', '', 42, null, { a: 1 }]) {
    const e = parseWorktreeError(raw);
    assert.equal(e.code, 'git_error');
    assert.equal(e.message, String(raw instanceof Error ? raw.message : raw));
  }
});

test('an existing WorktreeError passes through', () => {
  const e = new WorktreeError('dirty', 'x');
  assert.equal(parseWorktreeError(e), e);
});

test('only repository problems fall back to the shadow copy', () => {
  for (const c of ['not_a_git_repo', 'bare_repo', 'no_commits']) assert.equal(needsShadowCopyFallback(`${c}: x`), true, c);
  for (const c of ['dirty', 'task_exists', 'git_error', 'invalid_base']) assert.equal(needsShadowCopyFallback(`${c}: x`), false, c);
});
