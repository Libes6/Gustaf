import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedFiles, branchNameProblem, candidates, commitProblem, createAcceptedStore, initialSelection, offeredFiles, suggestBranchName,
} from '../src/lib/gitCommit.ts';

const file = (path, kind = 'modified', staged = false) => ({ path, kind, staged });
const status = (files, over = {}) => ({
  repo: true, toplevel: '/p', prefix: '', branch: 'main', detached: false, head: 'abc1234', files, total: files.length, inProgress: null, ...over,
});

test('accepted files are tracked per project root, de-duplicated and normalized', () => {
  const store = createAcceptedStore();
  store.add('/p', 'a.ts');
  store.add('/p', './b.ts');
  store.add('/p', 'a.ts');
  store.add('/q', 'c.ts');
  store.add('/p', '');
  store.add('', 'x.ts');
  assert.deepEqual(store.list('/p'), ['b.ts', 'a.ts']);
  assert.deepEqual(store.list('/q'), ['c.ts']);
  assert.deepEqual(store.list('/none'), []);
  store.forget('/p', ['./a.ts', 'missing.ts']);
  assert.deepEqual(store.list('/p'), ['b.ts']);
  store.forget('/p', ['b.ts']);
  store.forget('/none', ['x']);
  assert.deepEqual(store.list('/p'), []);
  assert.ok(acceptedFiles && typeof acceptedFiles.add === 'function');
});

test('the accepted list is bounded', () => {
  const store = createAcceptedStore();
  for (let i = 0; i < 5100; i++) store.add('/p', `f${i}.ts`);
  const list = store.list('/p');
  assert.equal(list.length, 5000);
  assert.equal(list.at(-1), 'f5099.ts');
  assert.ok(!list.includes('f0.ts'));
});

test('the offer only contains accepted files that are still changed and committable', () => {
  const st = status([file('a.ts'), file('b.ts', 'untracked'), file('c.ts', 'conflicted'), file('d.ts', 'deleted')]);
  assert.deepEqual(offeredFiles(st, ['a.ts', 'c.ts', 'd.ts', 'gone.ts', './b.ts']).map((f) => f.path), ['a.ts', 'b.ts', 'd.ts']);
  assert.deepEqual(offeredFiles(st, []), []);
  assert.deepEqual(offeredFiles(null, ['a.ts']), []);
  assert.deepEqual(offeredFiles(status([file('a.ts')], { repo: false }), ['a.ts']), []);
});

test('candidates list accepted files first and pre-select only those', () => {
  const st = status([file('a.ts'), file('b.ts'), file('c.ts', 'conflicted'), file('d.ts', 'untracked')]);
  const list = candidates(st, ['d.ts', 'c.ts']);
  assert.deepEqual(list.map((f) => [f.path, f.accepted]), [['c.ts', true], ['d.ts', true], ['a.ts', false], ['b.ts', false]]);
  assert.deepEqual([...initialSelection(list)], ['d.ts'], 'conflicted files are never pre-selected');
  assert.deepEqual(candidates(null, []), []);
  assert.deepEqual([...initialSelection(candidates(st, []))], []);
});

test('branch names follow git check-ref-format', () => {
  for (const ok of ['feature/x', 'gustaf/fix-login', 'a', 'v1.2', 'a/b/c', 'ünï/cødé', 'x@y']) assert.equal(branchNameProblem(ok), null, ok);
  assert.equal(branchNameProblem(''), 'empty');
  assert.equal(branchNameProblem('   '), 'empty');
  for (const bad of ['a b', '-x', '--detach', 'a..b', 'a~1', 'a^', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'x.lock', 'a/x.lock', '/x', 'x/', 'a//b', '.hidden', 'a/.hidden', 'x.', '@{u}', '@', 'HEAD', 'tab\tname', 'nl\nname', 'x'.repeat(201)]) {
    assert.equal(branchNameProblem(bad), 'invalid', JSON.stringify(bad));
  }
  assert.equal(branchNameProblem('  feature/x  '), null, 'surrounding whitespace is trimmed (and trimmed again by the backend)');
});

test('suggested branch names are always valid', () => {
  assert.equal(suggestBranchName('Fix: login redirect loop'), 'gustaf/fix-login-redirect-loop');
  assert.equal(suggestBranchName('feat(ui): Add "Commit…" dialog\n\nBody text'), 'gustaf/feat-ui-add-commit-dialog');
  assert.equal(suggestBranchName('Café résumé'), 'gustaf/cafe-resume');
  assert.equal(suggestBranchName('Исправить ошибку входа'), 'gustaf/changes');
  assert.equal(suggestBranchName(''), 'gustaf/changes');
  assert.equal(suggestBranchName('x'.repeat(100)), `gustaf/${'x'.repeat(40)}`);
  assert.equal(suggestBranchName(`${'a'.repeat(39)} b`), `gustaf/${'a'.repeat(39)}`);
  for (const m of ['Fix: login', '', '...', '---', 'Исправить', 'a/b', '@{u}', 'HEAD', 'x.lock']) assert.equal(branchNameProblem(suggestBranchName(m)), null, m);
});

test('commit problems are reported in a fixed order', () => {
  const st = status([file('a.ts'), file('c.ts', 'conflicted')]);
  const noBranch = { create: false, name: '' };
  assert.equal(commitProblem(null, ['a.ts'], 'msg', noBranch), 'notRepo');
  assert.equal(commitProblem(status([], { repo: false }), ['a.ts'], 'msg', noBranch), 'notRepo');
  assert.equal(commitProblem(status([file('a.ts')], { inProgress: 'merge' }), ['a.ts'], 'msg', noBranch), 'inProgress');
  assert.equal(commitProblem(st, [], 'msg', noBranch), 'noFiles');
  assert.equal(commitProblem(st, ['c.ts'], 'msg', noBranch), 'noFiles', 'a conflicted file does not count');
  assert.equal(commitProblem(st, ['unknown.ts'], 'msg', noBranch), 'noFiles');
  assert.equal(commitProblem(st, ['a.ts'], '  \n', noBranch), 'noMessage');
  assert.equal(commitProblem(st, ['a.ts'], 'msg', { create: true, name: 'bad name' }), 'badBranch');
  assert.equal(commitProblem(st, ['a.ts'], 'msg', { create: true, name: '' }), 'badBranch');
  assert.equal(commitProblem(st, ['a.ts'], 'msg', { create: false, name: 'bad name' }), null, 'an unticked branch field is ignored');
  assert.equal(commitProblem(st, new Set(['a.ts', 'c.ts']), 'msg', { create: true, name: 'feature/x' }), null);
});
