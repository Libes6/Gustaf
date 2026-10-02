import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const m = await import('../src/agent/agentRunsModel.ts');
const store = await import('../src/agent/agentRuns.ts');

const run = (over = {}) => ({
  id: 'r1', title: 'T', type: 'explore', providerId: 'p', model: 'mod', projectRoot: '/proj', status: 'completed',
  createdAt: 1000, startedAt: 1000, endedAt: 5000, tokens: 10, toolUses: 2, currentStep: '', transcript: [], ...over,
});

test('normalization drops junk, clips fields and bounds the transcript', () => {
  assert.deepEqual(m.normalizeRuns('nope'), []);
  const long = 'x'.repeat(5000);
  const raw = [
    run({ id: 'ok', title: long, summary: long, transcript: Array.from({ length: 500 }, (_, i) => ({ at: i, kind: 'tool', tool: 'read_file', text: long, result: long })) }),
    { id: 'bad-type', type: 'root', status: 'completed' },
    { id: 'bad-status', type: 'plan', status: 'weird' },
    null,
    run({ id: 'steps', transcript: [{ kind: 'bogus' }, { kind: 'text', text: 'hi', at: 1 }, 5] }),
  ];
  const out = m.normalizeRuns(raw);
  assert.deepEqual(out.map((r) => r.id), ['ok', 'steps']);
  assert.ok(out[0].title.length <= 80);
  assert.ok(out[0].summary.length <= m.MAX_SUMMARY);
  assert.equal(out[0].transcript.length, m.MAX_STEPS_PERSISTED);
  assert.ok(out[0].transcript[0].text.length <= m.MAX_STEP_TEXT);
  assert.deepEqual(out[1].transcript.map((s) => s.text), ['hi']);
});

test('runs that were active when the app stopped load as interrupted', () => {
  const out = m.normalizeRuns([run({ id: 'a', status: 'running', endedAt: undefined, currentStep: 'read_file x' }), run({ id: 'b', status: 'queued', endedAt: undefined }), run({ id: 'c' })], 9000);
  assert.deepEqual(out.map((r) => r.status), ['interrupted', 'interrupted', 'completed']);
  assert.equal(out[0].endedAt, 9000);
  assert.equal(out[0].currentStep, '');
  assert.equal(out[2].endedAt, 5000);
});

test('the list is bounded: every active run is kept, the oldest finished ones go first', () => {
  const runs = [
    ...Array.from({ length: 70 }, (_, i) => run({ id: `d${i}`, createdAt: 100 + i })),
    run({ id: 'live', status: 'running', createdAt: 1, endedAt: undefined }),
  ];
  const out = m.boundRuns(runs);
  assert.equal(out.length, m.MAX_RUNS);
  assert.ok(out.some((r) => r.id === 'live'));
  assert.ok(!out.some((r) => r.id === 'd0'));
  assert.equal(out.find((r) => r.id === 'd69') !== undefined, true);
  assert.equal(m.boundRuns(runs, 5).length, 5);
});

test('merging keeps this session in front and wins by id', () => {
  const merged = m.mergeRuns([run({ id: 'old', createdAt: 1 }), run({ id: 'same', title: 'from disk', createdAt: 2 })], [run({ id: 'same', title: 'live', createdAt: 3 })]);
  assert.deepEqual(merged.map((r) => [r.id, r.title]), [['same', 'live'], ['old', 'T']]);
});

test('persisted copy cuts transcripts', () => {
  const r = run({ transcript: Array.from({ length: 150 }, (_, i) => ({ at: i, kind: 'text', text: `s${i}` })) });
  assert.equal(m.forPersist([r])[0].transcript.length, m.MAX_STEPS_PERSISTED);
  assert.equal(m.forPersist([r])[0].transcript.at(-1).text, 's149');
  assert.equal(m.appendStep(Array.from({ length: m.MAX_STEPS_IN_MEMORY }, (_, i) => ({ at: i, kind: 'note', text: '' })), { at: 999, kind: 'note', text: '' }).length, m.MAX_STEPS_IN_MEMORY);
});

test('elapsed time and token formatting', () => {
  assert.equal(m.elapsed({ status: 'running', startedAt: 1000 }, 66_000), '1:05');
  assert.equal(m.elapsed({ status: 'completed', startedAt: 0 + 1, endedAt: 3_700_001 }, 9e9), '1:01:40');
  assert.equal(m.elapsed({ status: 'queued', startedAt: 0 }, 5000), '');
  assert.equal(m.formatTokens(999), '999');
  assert.equal(m.formatTokens(1500), '1.5k');
  assert.equal(m.formatTokens(25_000), '25k');
  assert.equal(m.formatTokens(2_500_000), '2.5M');
  assert.equal(m.runTokens({ input: 3, output: 4 }), 7);
  assert.equal(m.runTokens(undefined), 0);
});

test('store: runs are persisted in settings; a restart marks unfinished runs interrupted', async () => {
  state.reset();
  store.resetAgentRuns();
  const id = store.createRun({ title: 'Live', type: 'general', providerId: 'p', model: 'm', projectRoot: '/proj' }, () => {});
  store.updateRun(id, { status: 'running', startedAt: Date.now() });
  store.recordStep(id, { at: 1, kind: 'tool', tool: 'read_file', text: 'a.ts' }, { tokens: 7, toolUses: 1 }, 'read_file a.ts');
  const done = store.createRun({ title: 'Done', type: 'explore', providerId: 'p', model: 'm', projectRoot: '/proj' }, () => {});
  store.updateRun(done, { status: 'completed', endedAt: Date.now() });
  await sleep(1300); // writes are batched
  const saved = JSON.parse(state.settings.get('agentRuns'));
  assert.deepEqual(saved.map((r) => r.title).sort(), ['Done', 'Live']);
  assert.equal(saved.find((r) => r.title === 'Live').tokens, 7);

  // "Restart": memory is gone, only the setting remains.
  store.resetAgentRuns();
  await store.loadAgentRuns();
  const runs = store.getRuns();
  assert.equal(runs.find((r) => r.title === 'Live').status, 'interrupted');
  assert.ok(runs.find((r) => r.title === 'Live').endedAt);
  assert.equal(runs.find((r) => r.title === 'Done').status, 'completed');
  assert.equal(runs.find((r) => r.title === 'Live').transcript[0].tool, 'read_file');
  // the interrupted state is written back, so a second restart sees the same
  await sleep(50);
  assert.equal(JSON.parse(state.settings.get('agentRuns')).find((r) => r.title === 'Live').status, 'interrupted');
});

test('store: stopRun calls the stopper of an active run only; removeFinished keeps active runs', async () => {
  state.reset();
  store.resetAgentRuns();
  let stopped = 0;
  const a = store.createRun({ title: 'A', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p1' }, () => stopped++);
  const b = store.createRun({ title: 'B', type: 'plan', providerId: 'p', model: 'm', projectRoot: '/p2' }, () => {});
  store.updateRun(b, { status: 'failed', endedAt: 1 });
  store.stopRun(a);
  store.stopRun(b); // finished: its stopper is gone
  assert.equal(stopped, 1);
  store.removeFinished();
  assert.deepEqual(store.getRuns().map((r) => r.title), ['A']);
});
