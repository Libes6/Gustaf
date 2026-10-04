// Workspaces (one git worktree per task): "New workspace…" from the project menu makes the worktree and a linked chat,
// the chat shows under its project with its branch, and Archive removes the worktree again (chat kept).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gone, openApp, scenario, shown, skipReason, startSuite, until } from './harness.mjs';

let suite;
before(async () => { if (!skipReason) suite = await startSuite(); });
after(async () => { await suite?.close(); });

const PROJECT = '/fake/projects/shop';
const repoStatus = { repo: true, toplevel: PROJECT, prefix: '', branch: 'main', detached: false, head: 'c0ffee0', files: [], total: 0, inProgress: null };

test('workspaces: create from the project menu, see it grouped under the project, archive it', { skip: skipReason }, async () => {
  await scenario(suite, 'workspaces', {
    setup: (b) => {
      b.seedReady();
      b.seedProject('Shop', PROJECT);
      b.on('git_status', () => repoStatus);
    },
  }, async ({ page, backend, origin }) => {
    await openApp(page, origin);
    const side = page.getByRole('complementary', { name: 'Chats and projects' });
    await shown(side.getByText('Shop'));

    await side.getByText('Shop', { exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New workspace…' }).click();
    const dialog = page.getByRole('dialog', { name: 'New workspace' });
    await dialog.getByRole('textbox', { name: 'What is the task?' }).fill('Fix the checkout bug');
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await gone(dialog);

    // The worktree and the linked chat exist, and the chat shows in the project's workspace group with its branch.
    const [created] = backend.callsOf('worktree_create');
    assert.equal(created.root, PROJECT);
    assert.equal(created.slug, 'fix-the-checkout-bug');
    const [chat] = backend.rows('select title, project_id, workspace_task_id, workspace_branch, workspace_base from chats');
    assert.equal(chat.title, 'Fix the checkout bug');
    assert.equal(chat.workspace_task_id, created.taskId);
    assert.equal(chat.workspace_branch, 'gustaf/fix-the-checkout-bug');
    assert.equal(chat.workspace_base, 'c0ffee0123456789');
    const group = side.getByRole('group', { name: 'Workspaces of Shop' });
    await shown(group.getByText('gustaf/fix-the-checkout-bug'));
    await shown(page.getByText('Workspace gustaf/fix-the-checkout-bug'));

    // Archive: the worktree goes, the chat stays (marked archived).
    await group.locator('.row.workspace').hover(); // the row actions show on hover
    await group.getByRole('button', { name: 'Workspace actions: Fix the checkout bug' }).click();
    await page.getByRole('menuitem', { name: 'Archive workspace' }).click();
    await until(() => backend.callsOf('worktree_remove').length === 1, 'worktree_remove called');
    assert.deepEqual(backend.callsOf('worktree_remove')[0], { root: PROJECT, taskId: created.taskId, force: false, deleteBranch: false });
    await shown(group.getByText('archived'));
    assert.equal(backend.rows('select id from chats').length, 1);
  });
});
