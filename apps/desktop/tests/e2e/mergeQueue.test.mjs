// Merge queue: the project's "Merge queue…" dialog enqueues a workspace, the test command goes through the command
// approval card before it runs, the item ends up merged, and the workspace can be archived with one click. The queue
// itself is a small stand-in for src-tauri/src/merge_queue.rs (the Rust side has its own tests).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gone, openApp, scenario, shown, skipReason, startSuite, until } from './harness.mjs';

let suite;
before(async () => { if (!skipReason) suite = await startSuite(); });
after(async () => { await suite?.close(); });

const PROJECT = '/fake/projects/shop';
const repoStatus = { repo: true, toplevel: PROJECT, prefix: '', branch: 'main', detached: false, head: 'c0ffee0', files: [], total: 0, inProgress: null };
const worktree = { taskId: 'w1', path: '/fake/worktrees/w1', branch: 'gustaf/fix-cart', baseCommit: 'c0ffee01', baseBranch: 'main', createdAt: 1, provider: null, model: null, headSha: 'c0ffee01', changedFiles: 0, ahead: 2, behind: 0, dirty: false, existsOnDisk: true };

test('merge queue: enqueue, approve the test command, merged, archive', { skip: skipReason }, async () => {
  const queue = { version: 1, halted: false, items: [], updatedAt: 1 };
  let step = 0;
  await scenario(suite, 'merge-queue', {
    setup: (b) => {
      b.seedReady();
      const projectId = b.seedProject('Shop', PROJECT);
      const now = Date.now();
      b.db.prepare('insert into chats(project_id, title, created_at, updated_at, workspace_task_id, workspace_branch, workspace_base) values(?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, 'Fix the cart', now, now, 'w1', 'gustaf/fix-cart', 'c0ffee01');
      b.worktrees.push({ ...worktree });
      b.on('git_status', () => repoStatus);
      b.on('conflicts_check', () => ({ taskId: 'w1', branch: worktree.branch, target: 'main', clean: true, checks: [{ againstTaskId: null, against: 'main', clean: true, conflicts: [], truncated: false }] }));
      b.on('queue_status', () => queue);
      b.on('queue_enqueue', (a) => {
        queue.items = a.taskIds.map((taskId) => ({ taskId, branch: worktree.branch, status: 'queued', error: null, conflicts: [], strategy: a.strategy, testCommand: a.testCommand, targetBranch: 'main', enqueuedAt: 5, startedAt: null, finishedAt: null }));
        return queue;
      });
      b.on('queue_run_next', () => {
        step++;
        const item = queue.items[0];
        if (step === 1) {
          item.status = 'testing';
          return { outcome: 'needs_test', taskId: 'w1', needsTest: { taskId: 'w1', worktreePath: worktree.path, command: item.testCommand }, state: queue };
        }
        item.status = 'merged'; item.finishedAt = 9;
        return { outcome: 'merged', taskId: 'w1', needsTest: null, state: queue };
      });
      b.on('queue_report_test', () => { queue.items[0].status = 'merging'; return queue; });
    },
  }, async ({ page, backend, origin }) => {
    await openApp(page, origin);
    const side = page.getByRole('complementary', { name: 'Chats and projects' });
    await shown(side.getByText('gustaf/fix-cart'));

    await side.getByText('Shop', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Merge queue…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Merge queue' });
    await dialog.getByRole('checkbox', { name: /Fix the cart/ }).check();
    await dialog.getByRole('textbox', { name: 'Test command (optional)' }).fill('npm test');
    await dialog.getByRole('button', { name: 'Start' }).click();

    // The test command waits for approval and has not run.
    const approval = page.getByRole('alertdialog', { name: /command/i });
    await shown(approval);
    assert.deepEqual(backend.shellCommands, []);
    await approval.getByRole('button', { name: 'Allow' }).click();
    await shown(dialog.locator('.mq-status[data-status="merged"]'));
    assert.deepEqual(backend.shellCommands, ['npm test']);
    assert.deepEqual(backend.callsOf('queue_report_test')[0], { root: PROJECT, taskId: 'w1', ok: true, output: 'ok\n' });
    assert.equal(backend.callsOf('queue_enqueue')[0].strategy, 'merge');

    await dialog.getByRole('button', { name: 'Archive this workspace' }).click();
    await until(() => backend.callsOf('worktree_remove').length === 1, 'worktree_remove called');
    assert.deepEqual(backend.callsOf('worktree_remove')[0], { root: PROJECT, taskId: 'w1', force: false, deleteBranch: false });
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await gone(dialog);
  });
});
