// Scheduled runs on the real agent loop: scripted model, real temporary project, in-memory chat store. Covers access
// capping, no Computer Use, approvals that are never answered automatically (timeout -> "needs attention"), the action
// log source, chat reuse, failure paths and the runner's overlap prevention.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { executeScheduledRun, createRunner } = await import('../src/lib/scheduledRun.ts');
const sp = await import('../src/lib/scheduledPrompts.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');
const { clearActionLog, getActionLog } = await import('../src/agent/actionLogStore.ts');

before(() => saveRulesConfig(DEFAULT_RULES));

let n = 0;
const call = (name, args) => ({ type: 'tool_call', id: `c${n++}`, name, args });
const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
const say = (text) => ({ parts: [{ type: 'text', text }], usage });
const use = (...calls) => ({ parts: calls, usage });

const schedule = (over = {}) => ({ ...sp.createSchedule({ title: 'Nightly', prompt: 'Check the build', projectId: 1, providerId: 'p', model: 'm', access: 'auto', schedule: { kind: 'daily', time: '09:00' } }, 's1', 0), enabled: true, confirmedAt: 1, ...over });

/** Dependencies over an in-memory chat store and a scripted model. */
function harness({ script = [say('all good')], root = mkdtempSync(join(tmpdir(), 'sched-')), timeout = 40, ask, own = false, project = 'same', existingChat = null, resolveError } = {}) {
  state.reset();
  clearActionLog();
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const seen = { turns: [], approvals: 0, asked: [], badges: [], ended: 0, messages: [], created: [], usage: [], results: [], bumped: [], reviews: [] };
  let i = 0;
  const adapter = {
    supportsComputer: true,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      seen.turns.push({ access: input.access, tools: input.tools.map((t) => t.name), system: input.system, messages: [...input.messages] });
      return script[i++] ?? say('done');
    },
  };
  const deps = {
    now: Date.now,
    resolve: async () => (resolveError ? { error: resolveError } : { adapter, supportsTools: true, ownTools: own }),
    projectRoot: (id) => (id === null ? null : project === 'same' ? root : project === 'gone' ? undefined : project),
    allowlist: () => [],
    reasoning: () => 'medium',
    findChat: async () => existingChat,
    createChat: async (projectId, title) => (seen.created.push({ projectId, title }), 42),
    addMessage: async (chatId, msg) => (seen.messages.push({ chatId, msg }), seen.messages.length),
    beginApproval: (chatId, who) => (seen.badges.push({ chatId, who }), () => void seen.ended++),
    askUser: (info, onAnswer) => {
      seen.asked.push(info);
      ask?.(onAnswer, info);
      return () => {};
    },
    recordUsage: (p, m, u) => seen.usage.push({ p, m, u }),
    bumpUsage: (p) => seen.bumped.push(p),
    recordResult: (p, e) => seen.results.push({ p, e }),
    note: (kind, detail) => `${kind}:${detail ?? ''}`,
    approvalTimeoutMs: timeout,
  };
  return { deps, seen, root };
}

test('a scheduled run writes the prompt and the replies to a new "⏰ title" chat and counts usage', async () => {
  const { deps, seen } = harness();
  const r = await executeScheduledRun(schedule(), deps, new AbortController().signal);
  assert.deepEqual(r, { status: 'success', chatId: 42 });
  assert.deepEqual(seen.created, [{ projectId: 1, title: '⏰ Nightly' }]);
  assert.deepEqual(seen.messages.map((m) => [m.chatId, m.msg.role]), [[42, 'user'], [42, 'assistant']]);
  assert.equal(seen.messages[0].msg.parts[0].text, 'Check the build');
  assert.equal(seen.usage.length, 1, 'tokens go to the same counters as a normal chat');
  assert.deepEqual(seen.bumped, ['p']);
  assert.deepEqual(seen.results, [{ p: 'p', e: undefined }]);
});

test('an existing chat is reused and only the prompt goes to the model (no earlier runs)', async () => {
  const { deps, seen } = harness({ existingChat: 7 });
  const r = await executeScheduledRun(schedule({ lastChatId: 7 }), deps, new AbortController().signal);
  assert.equal(r.chatId, 7);
  assert.deepEqual(seen.created, []);
  assert.equal(seen.turns[0].messages.length, 1);
});

test('full access in stored data is capped to auto; Computer Use is never offered', async () => {
  const { deps, seen } = harness();
  await executeScheduledRun(schedule({ access: 'full' }), deps, new AbortController().signal);
  assert.equal(seen.turns[0].access, 'auto');
  assert.ok(!seen.turns[0].tools.includes('computer'), 'no computer tool even though the adapter supports it');
  assert.ok(!seen.turns[0].tools.includes('spawn_agent'), 'no subagents');
  assert.ok(!/cu_execute|Computer Use enabled/i.test(seen.turns[0].system));
});

test('read-only schedules stay read-only, and CLI agents (own tools) are forced to read-only', async () => {
  const a = harness();
  await executeScheduledRun(schedule({ access: 'readonly' }), a.deps, new AbortController().signal);
  assert.equal(a.seen.turns[0].access, 'readonly');
  const b = harness({ own: true });
  await executeScheduledRun(schedule({ access: 'auto' }), b.deps, new AbortController().signal);
  assert.equal(b.seen.turns[0].access, 'readonly');
});

test('tool calls are logged with source "scheduled"', async () => {
  const { deps } = harness({ script: [use(call('list_dir', { path: '.' })), say('ok')] });
  await executeScheduledRun(schedule({ access: 'readonly' }), deps, new AbortController().signal);
  const entries = getActionLog().entries.filter((e) => e.tool === 'list_dir');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, 'scheduled');
});

test('an approval request is shown, never auto-approved: unanswered it times out as "needs attention" and nothing runs', async () => {
  const { deps, seen } = harness({ script: [use(call('run_command', { command: 'npm publish' })), say('after')], timeout: 40 });
  const r = await executeScheduledRun(schedule(), deps, new AbortController().signal);
  assert.equal(r.status, 'attention');
  assert.deepEqual(state.runs, [], 'the command was not executed');
  assert.deepEqual(seen.asked.map((a) => a.command), ['npm publish']);
  assert.deepEqual(seen.badges, [{ chatId: 42, who: 'Nightly' }], 'sidebar badge / notification registered');
  assert.equal(seen.ended, 1, 'and cleared again');
  assert.equal(seen.turns.length, 1, 'the run was stopped, the model was not asked again');
  assert.ok(seen.messages.some((m) => m.msg.role === 'assistant' && m.msg.parts[0].text === 'attention:'), 'the chat explains why it stopped');
});

test('when the user allows the request the command runs; when they deny it, it does not', async () => {
  const allow = harness({ script: [use(call('run_command', { command: 'npm publish' })), say('done')], timeout: 5000, ask: (answer) => setTimeout(() => answer(true), 10) });
  const ok = await executeScheduledRun(schedule(), allow.deps, new AbortController().signal);
  assert.equal(ok.status, 'success');
  assert.deepEqual(state.runs.map((r) => r.command), ['npm publish']);
  const deny = harness({ script: [use(call('run_command', { command: 'npm publish' })), say('done')], timeout: 5000, ask: (answer) => setTimeout(() => answer(false), 10) });
  const no = await executeScheduledRun(schedule(), deny.deps, new AbortController().signal);
  assert.equal(no.status, 'success');
  assert.deepEqual(state.runs, []);
});

test('rules still apply: a denied command is blocked without even asking', async () => {
  const { deps, seen } = harness({ script: [use(call('run_command', { command: 'rm -rf /' })), say('x')] });
  await executeScheduledRun(schedule(), deps, new AbortController().signal);
  assert.deepEqual(state.runs, []);
  assert.deepEqual(seen.asked, []);
});

test('stopping a run marks it stopped', async () => {
  const ctl = new AbortController();
  const { deps } = harness({ script: [use(call('run_command', { command: 'npm publish' })), say('x')], timeout: 5000, ask: () => setTimeout(() => ctl.abort(), 10) });
  const r = await executeScheduledRun(schedule(), deps, ctl.signal);
  assert.equal(r.status, 'stopped');
  assert.deepEqual(state.runs, []);
});

test('failures: a provider that cannot be resolved, a deleted project, a model error', async () => {
  const a = harness({ resolveError: 'no provider' });
  assert.deepEqual(await executeScheduledRun(schedule(), a.deps, new AbortController().signal), { status: 'failed', chatId: null, error: 'no provider' });
  const b = harness({ project: 'gone' });
  const gone = await executeScheduledRun(schedule(), b.deps, new AbortController().signal);
  assert.equal(gone.status, 'failed');
  assert.match(gone.error, /no longer exists/);
  const c = harness({ script: [() => { throw new Error('boom'); }] });
  c.deps.resolve = async () => ({ adapter: { supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: async () => { throw new Error('boom'); } } });
  const failed = await executeScheduledRun(schedule(), c.deps, new AbortController().signal);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /boom/);
  assert.deepEqual(c.seen.results, [{ p: 'p', e: failed.error }], 'recorded as a provider failure like a chat error');
  assert.ok(c.seen.messages.some((m) => m.msg.parts[0].text.startsWith('failed:')));
});

// ---- runner ----

function memoryStore(initial) {
  let list = initial;
  return { get: () => list, update: (fn) => void (list = sp.normalizeScheduled(fn(list))) };
}

test('runner: a schedule never runs twice at once; the due occurrence during a run is dropped', async () => {
  const now = new Date(2026, 4, 10, 9, 0, 0).getTime();
  const store = memoryStore([schedule({ schedule: { kind: 'interval', everyMinutes: 5 }, nextRunAt: now })]);
  let started = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  let clock = now;
  const runner = createRunner(store, async () => (started++, await gate, { status: 'success', chatId: 5 }), () => clock);
  runner.tick();
  runner.tick();
  assert.equal(started, 1);
  assert.equal(runner.isRunning('s1'), true);
  assert.equal(runner.runNow('s1'), false, '"Run now" cannot overlap either');
  clock = now + 6 * 60_000; // the next occurrence comes due while the run is still active
  runner.tick();
  assert.equal(started, 1);
  assert.equal(store.get()[0].nextRunAt, clock + 5 * 60_000);
  release();
  await sleep(10);
  assert.equal(runner.isRunning('s1'), false);
  const s = store.get()[0];
  assert.equal(s.lastStatus, 'success');
  assert.equal(s.lastChatId, 5);
  clock += 6 * 60_000;
  runner.tick();
  assert.equal(started, 2, 'the next occurrence runs once the previous run is over');
});

test('runner: disabled or unconfirmed schedules do not run, "Run now" does; failures are recorded', async () => {
  const now = new Date(2026, 4, 10, 9, 0, 0).getTime();
  const store = memoryStore([schedule({ enabled: false, nextRunAt: now - 1000 }), schedule({ id: 's2', title: 'B', nextRunAt: now - 1000, confirmedAt: undefined })]);
  let started = [];
  const runner = createRunner(store, async (sc) => (started.push(sc.id), { status: 'failed', chatId: null, error: 'nope' }), () => now);
  runner.tick();
  assert.deepEqual(started, []);
  assert.equal(runner.runNow('s1'), true);
  await sleep(10);
  assert.deepEqual(started, ['s1']);
  assert.equal(store.get()[0].lastStatus, 'failed');
  assert.equal(store.get()[0].lastError, 'nope');
  assert.equal(store.get()[0].enabled, false, 'running it by hand does not enable it');
});

test('runner: a thrown error from the executor is recorded, not lost', async () => {
  const now = new Date(2026, 4, 10, 9, 0, 0).getTime();
  const store = memoryStore([schedule({ nextRunAt: now })]);
  const runner = createRunner(store, async () => { throw new Error('exploded'); }, () => now);
  runner.tick();
  await sleep(10);
  assert.equal(store.get()[0].lastStatus, 'failed');
  assert.match(store.get()[0].lastError, /exploded/);
  assert.equal(runner.isRunning('s1'), false);
});
