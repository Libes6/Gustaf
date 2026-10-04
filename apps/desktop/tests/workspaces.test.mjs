// Pure logic of workspaces (git worktree per task): slug and task id generation, cwd resolution for linked and unlinked
// chats, the sidebar row view model, archive choices, diff helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as w from '../src/lib/workspaces.ts';
import { relativeToProject, untrackedDiffText } from '../src/lib/workspaceDiff.ts';

const info = (over = {}) => ({
  taskId: 't1', path: '/store/abc/t1', branch: 'gustaf/fix-login', baseCommit: 'deadbeef', baseBranch: 'main', createdAt: 1,
  provider: null, model: null, headSha: 'cafe', changedFiles: 0, ahead: 0, behind: 0, dirty: false, existsOnDisk: true, ...over,
});
const linked = (over = {}) => ({ id: 7, title: 'Fix login', workspace_task_id: 't1', workspace_branch: 'gustaf/fix-login', workspace_base: 'deadbeef', ...over });

test('slugFromText takes the first words, ascii only, and falls back to "task"', () => {
  assert.equal(w.slugFromText('Fix the login bug in the auth module please'), 'fix-the-login-bug-in');
  assert.equal(w.slugFromText('  Hello,   World!!  '), 'hello-world');
  assert.equal(w.slugFromText('add v2.0 API'), 'add-v2-0-api');
  assert.equal(w.slugFromText('Исправить ошибку входа'), 'task');
  assert.equal(w.slugFromText(''), 'task');
  assert.equal(w.slugFromText(undefined), 'task');
  assert.equal(w.slugFromText('one two three', 2), 'one-two');
  assert.ok(w.slugFromText('x'.repeat(200)).length <= 40);
  assert.ok(!w.slugFromText('a-'.repeat(60)).endsWith('-'));
});

test('newTaskId is valid for the backend and unique among the existing ids', () => {
  const valid = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
  const id = w.newTaskId([], 1_700_000_000_000, () => 0.5);
  assert.match(id, valid);
  // Same time and random source: the taken id is skipped by the next draw.
  const draws = [0.5, 0.5, 0.25];
  const next = w.newTaskId([id], 1_700_000_000_000, () => draws.shift());
  assert.notEqual(next, id);
  assert.match(next, valid);
  // Many ids drawn from a constant random source still end up unique.
  const seen = new Set();
  for (let i = 0; i < 50; i++) { const n = w.newTaskId(seen, 5, () => 0); assert.ok(!seen.has(n)); seen.add(n); }
  assert.equal(seen.size, 50);
  for (const n of seen) assert.match(n, valid);
});

test('chatWorkspace reads the link and treats missing or empty ids as an ordinary chat', () => {
  assert.deepEqual(w.chatWorkspace(linked()), { taskId: 't1', branch: 'gustaf/fix-login', base: 'deadbeef' });
  assert.equal(w.chatWorkspace({ workspace_task_id: null }), null);
  assert.equal(w.chatWorkspace({ workspace_task_id: '' }), null);
  assert.equal(w.chatWorkspace({}), null);
  assert.equal(w.chatWorkspace(undefined), null);
  assert.deepEqual(w.chatWorkspace({ workspace_task_id: 'x' }), { taskId: 'x', branch: null, base: null });
});

test('an unlinked chat uses the project folder exactly as before', () => {
  assert.deepEqual(w.resolveChatRoot({ projectPath: '/work/alpha', workspace: null, known: undefined }), { state: 'project', root: '/work/alpha' });
  assert.deepEqual(w.resolveChatRoot({ projectPath: null, workspace: null, known: [info()] }), { state: 'project', root: null });
  // The list of workspaces is irrelevant to it.
  assert.equal(w.resolveChatRoot({ projectPath: '/work/alpha', workspace: null, known: [info()], prefix: 'sub/' }).root, '/work/alpha');
});

test('a linked chat uses its checkout and never the project folder', () => {
  const ws = w.chatWorkspace(linked());
  const r = w.resolveChatRoot({ projectPath: '/work/alpha', workspace: ws, known: [info(), info({ taskId: 't2', path: '/store/abc/t2' })], prefix: '' });
  assert.equal(r.state, 'workspace');
  assert.equal(r.root, '/store/abc/t1');
  assert.equal(r.info.branch, 'gustaf/fix-login');
  // A project in a repository subfolder works in the same subfolder of the checkout.
  assert.equal(w.resolveChatRoot({ projectPath: '/work/alpha/app', workspace: ws, known: [info()], prefix: 'app/' }).root, '/store/abc/t1/app');
  assert.equal(w.joinCheckout('/store/abc/t1/', '/a/b/'), '/store/abc/t1/a/b');
  assert.equal(w.joinCheckout('/store/abc/t1', null), '/store/abc/t1');
});

test('a linked chat without a resolvable checkout has no root (no fallback to the main checkout)', () => {
  const ws = w.chatWorkspace(linked());
  assert.deepEqual(w.resolveChatRoot({ projectPath: '/work/alpha', workspace: ws, known: undefined }), { state: 'pending', root: null });
  assert.deepEqual(w.resolveChatRoot({ projectPath: '/work/alpha', workspace: ws, known: [] }), { state: 'missing', root: null });
  assert.deepEqual(w.resolveChatRoot({ projectPath: '/work/alpha', workspace: ws, known: [info({ taskId: 'other' })] }), { state: 'missing', root: null });
  assert.equal(w.resolveChatRoot({ projectPath: '/work/alpha', workspace: ws, known: [info({ existsOnDisk: false })] }).state, 'missing');
});

test('workspaceRow builds the sidebar row from the chat and the live info', () => {
  const row = w.workspaceRow(linked(), info({ changedFiles: 3, ahead: 2, behind: 1, dirty: true }), true);
  assert.equal(row.chatId, 7);
  assert.equal(row.branch, 'gustaf/fix-login');
  assert.equal(row.active, true);
  assert.equal(row.changedFiles, 3);
  assert.equal(row.sync, '↑2 ↓1');
  assert.equal(row.dirty, true);
  assert.equal(row.mergedLike, false);
  // Level with the base and clean: nothing to show, branch can go with the workspace.
  const level = w.workspaceRow(linked(), info(), true);
  assert.equal(level.sync, '');
  assert.equal(level.mergedLike, true);
  assert.equal(w.workspaceRow(linked(), info({ ahead: 0, behind: 4 }), true).sync, '↓4');
  // Unknown ahead/behind (no base branch): no claim.
  const unknown = w.workspaceRow(linked(), info({ ahead: null, behind: null }), true);
  assert.equal(unknown.sync, '');
  assert.equal(unknown.mergedLike, false);
});

test('workspaceRow: archived, still loading, and ordinary chats', () => {
  const gone = w.workspaceRow(linked(), undefined, true);
  assert.equal(gone.active, false);
  assert.equal(gone.branch, 'gustaf/fix-login', 'the stored branch name is kept');
  assert.equal(gone.changedFiles, null);
  assert.equal(w.workspaceRow(linked(), info({ existsOnDisk: false }), true).active, false);
  // Before the first list arrives the row does not flash "archived".
  assert.equal(w.workspaceRow(linked(), undefined, false).active, true);
  assert.equal(w.workspaceRow({ id: 1, title: 'plain' }, undefined, true), null);
});

test('splitWorkspaceChats separates workspace chats and keeps the order', () => {
  const chats = [{ id: 1 }, linked({ id: 2 }), { id: 3, workspace_task_id: null }, linked({ id: 4, workspace_task_id: 't4' })];
  const { plain, workspaces } = w.splitWorkspaceChats(chats);
  assert.deepEqual(plain.map((c) => c.id), [1, 3]);
  assert.deepEqual(workspaces.map((c) => c.id), [2, 4]);
});

test('archiveChoices offers deleting the branch only when nothing would be lost', () => {
  assert.deepEqual(w.archiveChoices(info()), { canArchive: true, offerDeleteBranch: true });
  assert.deepEqual(w.archiveChoices(info({ ahead: 2 })), { canArchive: true, offerDeleteBranch: false });
  assert.deepEqual(w.archiveChoices(info({ ahead: null })), { canArchive: true, offerDeleteBranch: false });
  assert.deepEqual(w.archiveChoices(info({ dirty: true })), { canArchive: true, offerDeleteBranch: false });
  assert.deepEqual(w.archiveChoices(info({ existsOnDisk: false })), { canArchive: false, offerDeleteBranch: false });
  assert.deepEqual(w.archiveChoices(undefined), { canArchive: false, offerDeleteBranch: false });
});

test('diff helpers: project-relative paths and untracked file text', () => {
  assert.equal(relativeToProject('src/a.ts', ''), 'src/a.ts');
  assert.equal(relativeToProject('app/src/a.ts', 'app/'), 'src/a.ts');
  assert.equal(relativeToProject('other/a.ts', 'app/'), null);
  assert.equal(relativeToProject('apple/a.ts', 'app/'), null);
  assert.equal(untrackedDiffText('a\nb\n'), '@@ -0,0 +1,2 @@\n+a\n+b');
  assert.equal(untrackedDiffText(''), '@@ -0,0 +1,1 @@\n+');
});
