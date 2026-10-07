// The persisted list (settings table) and the approval list of unattended runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { state, setSetting, getSetting } = await import('./helpers/apiStub.mjs');
const store = await import('../src/lib/scheduledPromptsStore.ts');
const sp = await import('../src/lib/scheduledPrompts.ts');
const approvals = await import('../src/lib/scheduledApprovals.ts');

const base = (id, over = {}) => ({
  ...sp.createSchedule(
    {
      title: id,
      prompt: 'p',
      projectId: null,
      providerId: 'p',
      model: 'm',
      access: 'full',
      schedule: { kind: 'daily', time: '09:00' },
    },
    id,
    0,
  ),
  ...over,
});

test('loading normalizes stored data: no enabled without confirmation, no full access, interrupted runs recovered', async () => {
  store.resetScheduled();
  await setSetting(sp.SCHEDULED_PROMPTS_SETTING, [
    { ...base('a'), enabled: true },
    { ...base('b'), enabled: true, confirmedAt: 3, lastStatus: 'running' },
  ]);
  const list = await store.loadScheduled();
  assert.deepEqual(
    list.map((s) => [s.id, s.enabled, s.access, s.lastStatus]),
    [
      ['a', false, 'auto', undefined],
      ['b', true, 'auto', 'interrupted'],
    ],
  );
});

test('edits are saved normalized; an edit before the list is loaded is ignored (it would erase the stored one)', async () => {
  store.resetScheduled();
  await setSetting(sp.SCHEDULED_PROMPTS_SETTING, [base('a')]);
  store.updateScheduled(() => []);
  assert.equal((await getSetting(sp.SCHEDULED_PROMPTS_SETTING, [])).length, 1);
  await store.loadScheduled();
  store.updateScheduled((l) => [
    ...l,
    { ...base('b'), enabled: true },
    { ...base('c'), schedule: { kind: 'interval', everyMinutes: 1 } },
  ]);
  const saved = await getSetting(sp.SCHEDULED_PROMPTS_SETTING, []);
  assert.deepEqual(
    saved.map((s) => s.id),
    ['a', 'b', 'c'],
  );
  assert.equal(saved[1].enabled, false, 'a list edit cannot switch a schedule on without the confirmation');
  assert.equal(saved[2].schedule.everyMinutes, 5);
  state.reset();
});

test('the action log keeps the "scheduled" source when it is saved and loaded again', async () => {
  const { normalizeActionLog } = await import('../src/agent/actionLog.ts');
  const entry = { id: 'a', at: 1, tool: 'list_dir', summary: '.', status: 'success' };
  const [a, b] = normalizeActionLog([
    { ...entry, source: 'scheduled' },
    { ...entry, id: 'b', source: 'other' },
  ]);
  assert.equal(a.source, 'scheduled');
  assert.equal('source' in b, false);
});

test('approval requests are listed until answered; a late answer is ignored; withdrawn ones disappear', () => {
  const got = [];
  const close = approvals.openScheduledApproval({ scheduleId: 's', chatId: 1, title: 'T', command: 'ls' }, (ok) =>
    got.push(ok),
  );
  const [first] = approvals.getScheduledApprovals();
  assert.equal(first.command, 'ls');
  approvals.answerScheduledApproval(first.id, true);
  approvals.answerScheduledApproval(first.id, false);
  assert.deepEqual(got, [true]);
  assert.equal(approvals.getScheduledApprovals().length, 0);
  close();
  const withdrawn = approvals.openScheduledApproval({ scheduleId: 's', chatId: 1, title: 'T', command: 'ls' }, (ok) =>
    got.push(ok),
  );
  const [second] = approvals.getScheduledApprovals();
  withdrawn();
  approvals.answerScheduledApproval(second.id, true);
  assert.deepEqual(got, [true], 'nothing was answered for a withdrawn request');
  assert.equal(approvals.getScheduledApprovals().length, 0);
});
