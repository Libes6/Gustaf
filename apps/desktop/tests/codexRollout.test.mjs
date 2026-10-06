// Codex subagents read from rollout files (src/providers/codexRollout.ts): mapping of scan results to activities,
// dedupe across polls, wait collapsing and the polling lifecycle with an injected scan and fake timers.
// Synthetic fixtures only; the Rust side is tested in src-tauri/src/codex_agents.rs.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
await import('./helpers/apiStub.mjs');
const { rolloutActivities, createRolloutTracker } = await import('../src/providers/codexRollout.ts');
const { applyActivity, nativeActivities, isBareCollabWait } = await import('../src/providers/activities.ts');
const { trackCliAgents, getCliAgents, resetCliAgents, isCliAgentActive } = await import('../src/agent/cliAgents.ts');

const agent = (key, over = {}) => ({ id: `thread-${key}`, key, threadId: `thread-${key}`, parentThreadId: 'parent', depth: 1, nickname: `Nick ${key}`, taskName: `task_${key}`, state: 'running', startedAtMs: 1000, toolUses: 0, tokens: { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 }, ...over });
const scanOf = (...agents) => ({ parentFound: true, agents, truncated: false, notes: [] });
const flush = () => new Promise((r) => setImmediate(r));
const bareWait = (type, id) => ({ type, item: { id, type: 'collab_tool_call', tool: 'wait', sender_thread_id: 'main', receiver_thread_ids: [], prompt: null, agents_states: {}, status: type === 'item.started' ? 'in_progress' : 'completed' } });

test('three scanned agents become three subagent activities in scan order with states, result, step and counters', () => {
  const acts = rolloutActivities(scanOf(
    agent('a', { state: 'completed', lastMessage: 'alpha done\nwith detail', message: 'Inspect alpha', toolUses: 3, tokens: { total: 1200 }, endedAtMs: 5000, durationMs: 4000 }),
    agent('b', { state: 'running', step: 'cargo test', toolUses: 1 }),
    agent('c', { state: 'failed', error: 'stream failed' }),
  ));
  assert.deepEqual(acts.map((a) => a.id), ['codex:a', 'codex:b', 'codex:c']);
  const [a, b, c] = acts;
  assert.deepEqual([a.subagent.state, b.subagent.state, c.subagent.state], ['completed', 'running', 'failed']);
  assert.deepEqual([a.status, b.status, c.status], ['success', 'running', 'error']);
  assert.equal(a.subagent.provider, 'codex');
  assert.equal(a.subagent.title, 'task a');
  assert.equal(a.subagent.role, 'Nick a');
  assert.equal(a.subagent.prompt, 'Inspect alpha');
  assert.equal(a.subagent.result, 'alpha done with detail');
  assert.equal(a.output, 'alpha done\nwith detail');
  assert.deepEqual([a.subagent.toolUses, a.subagent.tokens, a.subagent.endedAt, a.subagent.durationMs, a.subagent.startedAt], [3, 1200, 5000, 4000, 1000]);
  assert.equal(b.subagent.step, 'cargo test');
  assert.equal(c.subagent.result, 'stream failed');
  assert.equal(c.output, 'stream failed');
});

test('shutdown reads as completed, starting as running, an unknown state as running; entries without a key and a missing list are skipped', () => {
  const acts = rolloutActivities(scanOf(agent('a', { state: 'shutdown' }), agent('b', { state: 'starting', threadId: null, id: 'pending:p:x', nickname: null }), agent('c', { state: 'weird' }), { state: 'running' }));
  assert.deepEqual(acts.map((a) => a.subagent.state), ['completed', 'running', 'running']);
  assert.equal(acts[1].subagent.title, 'task b');
  assert.equal(acts[1].subagent.agentId, 'pending:p:x');
  assert.deepEqual(rolloutActivities({}), []);
  assert.deepEqual(rolloutActivities(null), []);
});

test('a pending spawn and the thread that follows it are one entry; later scans replace the state instead of adding to it', () => {
  const map = new Map();
  const pending = agent('k', { state: 'starting', threadId: null, id: 'pending:p:k', nickname: null, message: 'Do k' });
  applyActivity(map, rolloutActivities(scanOf(pending))[0]);
  applyActivity(map, rolloutActivities(scanOf(agent('k', { state: 'running', toolUses: 2, step: 'ls' })))[0]);
  applyActivity(map, rolloutActivities(scanOf(agent('k', { state: 'running', toolUses: 4, step: 'wc' })))[0]);
  assert.equal(map.size, 1);
  let [e] = [...map.values()];
  assert.deepEqual([e.subagent.title, e.subagent.toolUses, e.subagent.step, e.subagent.agentId, e.subagent.prompt], ['task k', 4, 'wc', 'thread-k', 'Do k']);
  applyActivity(map, rolloutActivities(scanOf(agent('k', { state: 'completed', lastMessage: 'ok', toolUses: 4, endedAtMs: 7000 })))[0]);
  [e] = [...map.values()];
  assert.deepEqual([e.status, e.subagent.state, e.output], ['success', 'completed', 'ok']);
  // A genuine newer task_started proves that the same thread was woken.
  applyActivity(map, rolloutActivities(scanOf(agent('k', { state: 'running', turnStartedAtMs: 8000 })))[0]);
  assert.equal([...map.values()][0].status, 'running');
});

test('a real spawn event for an agent the scan already lists, and its waits, fold into the scanned entry', () => {
  const map = new Map();
  applyActivity(map, rolloutActivities(scanOf(agent('k')))[0]);
  const ev = (type, item) => ({ type, item: { type: 'collab_tool_call', sender_thread_id: 'main', receiver_thread_ids: [], agents_states: {}, status: 'completed', ...item } });
  for (const e of [ev('item.completed', { id: 'call-9', tool: 'spawn_agent', prompt: 'Do k', receiver_thread_ids: ['thread-k'] }), ev('item.completed', { id: 'w1', tool: 'wait', receiver_thread_ids: ['thread-k'], agents_states: { 'thread-k': { status: 'running' } } })]) {
    for (const a of nativeActivities('codex', e)) applyActivity(map, a);
  }
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].subagent.waits, 1);
});

test('bare waits are recognised, waits that name an agent are not', () => {
  assert.equal(isBareCollabWait(bareWait('item.started', 'w1')), true);
  assert.equal(isBareCollabWait(bareWait('item.completed', 'w1')), true);
  assert.equal(isBareCollabWait({ type: 'item.completed', item: { ...bareWait('x', 'w').item, receiver_thread_ids: ['t1'] } }), false);
  assert.equal(isBareCollabWait({ type: 'item.completed', item: { ...bareWait('x', 'w').item, agents_states: { t1: { status: 'completed' } } } }), false);
  assert.equal(isBareCollabWait({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent' } }), false);
  assert.equal(isBareCollabWait({ type: 'item.completed', item: { type: 'command_execution' } }), false);
  assert.equal(isBareCollabWait(null), false);
});

const harness = (scans, o = {}) => {
  const calls = [];
  const emitted = [];
  const debug = [];
  let n = 0;
  const tracker = createRolloutTracker({
    startedAt: 123,
    scan: async (id, at) => { calls.push([id, at]); const s = scans[Math.min(n++, scans.length - 1)]; if (s instanceof Error) throw s; return s; },
    onActivity: (a) => emitted.push(a),
    onDebug: (k, d) => debug.push([k, d]),
    ...o,
  });
  return { tracker, calls, emitted, debug };
};

test('polling starts at thread.started, repeats about every second, emits only changes and does a final scan at the end', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { tracker, calls, emitted } = harness([scanOf(agent('a')), scanOf(agent('a')), scanOf(agent('a'), agent('b')), scanOf(agent('a', { state: 'completed' }), agent('b'))]);
    await flush();
    assert.equal(calls.length, 0, 'nothing before the thread id is known');
    tracker.begin('thread-main');
    tracker.begin('thread-other');
    await flush();
    assert.deepEqual(calls, [['thread-main', 123]]);
    assert.equal(emitted.length, 1);
    mock.timers.tick(999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(emitted.length, 1, 'an unchanged scan emits nothing');
    mock.timers.tick(1000);
    await flush();
    assert.deepEqual(emitted.map((a) => a.id), ['codex:a', 'codex:b']);
    // The turn ends: the final scan picks up the last change, and polling stops.
    const fallback = await tracker.finish(true);
    assert.deepEqual(fallback.map((x) => [x.id, x.subagent.state, x.status]), [['codex:b', 'stopped', 'unknown']], 'b was still running when the turn ended');

    assert.equal(calls.length, 4);
    assert.equal(emitted.at(-1).subagent.state, 'completed');
    mock.timers.tick(10_000);
    await flush();
    assert.equal(calls.length, 4);
    assert.equal(await tracker.finish(true), fallback, 'a second call returns the same result without scanning again');
    assert.equal(calls.length, 4);
  } finally {
    mock.timers.reset();
  }
});

test('a stopped turn ends polling without a final scan; scans never overlap', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let release;
    let running = 0;
    let peak = 0;
    let started = 0;
    const { tracker } = harness([], {
      scan: async () => { started++; running++; peak = Math.max(peak, running); await new Promise((r) => (release = r)); running--; return scanOf(); },
    });
    tracker.begin('t');
    await flush();
    mock.timers.tick(5000);
    await flush();
    assert.deepEqual([peak, started], [1, 1], 'the next poll waits for the running scan');
    release();
    await flush();
    // The timer for the next poll is pending; the stop cancels it and no final scan runs.
    await tracker.finish(false);
    mock.timers.tick(5000);
    await flush();
    assert.deepEqual([running, started], [0, 1]);
  } finally {
    mock.timers.reset();
  }
});

test('scan errors never throw; five failures in a row end the polling, a success resets the count, notes are logged once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const bad = new Error('no files');
    const withNote = { ...scanOf(), notes: ['parent rollout not found'] };
    const { tracker, calls, debug } = harness([bad, withNote, withNote, bad, bad, bad, bad, bad, scanOf(agent('late'))]);
    tracker.begin('t');
    for (let i = 0; i < 12; i++) { await flush(); mock.timers.tick(1000); }
    await flush();
    assert.equal(calls.length, 8, 'stopped after five consecutive failures');
    assert.equal(debug.filter(([k]) => k === 'rollout-note').length, 1);
    assert.equal(debug.filter(([k]) => k === 'rollout-error').length, 6);
    await tracker.finish(false);
    assert.equal(debug.at(-1)[0], 'rollout-total');
  } finally {
    mock.timers.reset();
  }
});

test('waits that name no agent are dropped when the scan found agents and come back as one merged card when it found none', async () => {
  const held = (id, type) => nativeActivities('codex', bareWait(type, id));
  // Found: dropped.
  const a = harness([scanOf(agent('a'))]);
  a.tracker.begin('t');
  await flush();
  for (const id of ['w1', 'w2', 'w3']) { a.tracker.hold(held(id, 'item.started')); a.tracker.hold(held(id, 'item.completed')); }
  assert.deepEqual((await a.tracker.finish(true)).map((x) => [x.id, x.subagent?.state]), [['codex:a', 'stopped']], 'the held waits are dropped; the agent still running is settled as stopped');
  // Nothing found: one generic card, counting the waits, with the last event's output.
  const b = harness([scanOf()]);
  b.tracker.begin('t');
  await flush();
  for (const id of ['w1', 'w2', 'w3']) { b.tracker.hold(held(id, 'item.started')); b.tracker.hold(held(id, 'item.completed')); }
  const card = await b.tracker.finish(true);
  assert.equal(card.length, 1);
  assert.equal(card[0].id, 'w1');
  assert.equal(card[0].name, 'collab_tool_call');
  assert.equal(card[0].args.waits, 3);
  assert.equal(card[0].status, 'success');
  assert.match(card[0].output, /"wait"/);
  // The thread id never arrived (no scan at all): the same fallback.
  const c = harness([scanOf(agent('a'))]);
  c.tracker.hold(held('w9', 'item.completed'));
  assert.equal((await c.tracker.finish(true)).length, 1);
  assert.equal(c.calls.length, 0);
});

test('scan results flow into the agents column store with the real start time and tokens', () => {
  resetCliAgents();
  const map = new Map();
  const acts = rolloutActivities(scanOf(agent('a', { startedAtMs: 111, tokens: { total: 900 } }), agent('b', { state: 'completed', startedAtMs: 222, endedAtMs: 333 })));
  trackCliAgents({ chatId: 1, root: '/p' }, acts.map((a) => applyActivity(map, a)), 9999);
  const all = getCliAgents();
  assert.equal(all.length, 2);
  const a = all.find((e) => e.key === '1:codex:a');
  const b = all.find((e) => e.key === '1:codex:b');
  assert.deepEqual([a.startedAt, a.tokens, a.state, a.title], [111, 900, 'running', 'task a']);
  assert.deepEqual([b.startedAt, b.endedAt, b.state], [222, 333, 'completed']);
  resetCliAgents();
});

test('titles are the readable task (path segment, underscores as spaces); the nickname is the secondary line; a bare path never shows', () => {
  const [a, b, c, d] = rolloutActivities(scanOf(
    agent('a', { nickname: 'Pasteur', taskName: '/root/queue_resume', agentPath: '/root/queue_resume' }),
    agent('b', { nickname: null, taskName: '/root/branching' }),
    agent('c', { nickname: 'Tesla', taskName: null }),
    agent('d', { nickname: null, taskName: null, threadId: 'abcdef0123456789' }),
  ));
  assert.deepEqual([a.subagent.title, a.subagent.role], ['queue resume', 'Pasteur']);
  assert.deepEqual([b.subagent.title, b.subagent.role], ['branching', undefined]);
  assert.deepEqual([c.subagent.title, c.subagent.role], ['Tesla', undefined]);
  assert.equal(d.subagent.title, 'abcdef01');
  for (const x of [a, b, c, d]) assert.ok(!x.subagent.title.includes('/'));
});

test('a stopped scan state is a neutral stopped entry: not running, not failed, with its end time and no live step', () => {
  const [s] = rolloutActivities(scanOf(agent('s', { state: 'stopped', step: 'cargo test', endedAtMs: 7000, error: 'interrupted' })));
  assert.deepEqual([s.subagent.state, s.status, s.subagent.endedAt, s.subagent.step], ['stopped', 'unknown', 7000, undefined]);
  assert.equal(s.output, undefined, 'no error text is shown as a report');
  resetCliAgents();
  const map = new Map();
  trackCliAgents({ chatId: 1, root: '/p' }, [applyActivity(map, rolloutActivities(scanOf(agent('s', { state: 'stopped', endedAtMs: 7000 })))[0])], 9999);
  const [e] = getCliAgents();
  assert.deepEqual([e.state, e.endedAt, isCliAgentActive(e)], ['stopped', 7000, false]);
  resetCliAgents();
});

test('a stopped agent that a later scan lists as running again (a follow-up) is live again', () => {
  const map = new Map();
  applyActivity(map, rolloutActivities(scanOf(agent('k', { state: 'stopped', endedAtMs: 5 })))[0]);
  applyActivity(map, rolloutActivities(scanOf(agent('k', { state: 'running', turnStartedAtMs: 8000 })))[0]);
  assert.equal([...map.values()][0].subagent.state, 'running');
});

test('the end of the turn settles every agent still running as stopped (also when the run was stopped without a final scan); finished ones are untouched', async () => {
  for (const final of [true, false]) {
    const { tracker, emitted } = harness([scanOf(agent('a', { state: 'running', step: 'ls' }), agent('b', { state: 'starting', threadId: null, id: 'pending:p:b' }), agent('c', { state: 'completed', endedAtMs: 9 }), agent('d', { state: 'stopped' }))]);
    tracker.begin('t');
    await flush();
    const settled = await tracker.finish(final);
    assert.deepEqual(settled.map((x) => [x.id, x.subagent.state, x.status]), [['codex:a', 'stopped', 'unknown'], ['codex:b', 'stopped', 'unknown']]);
    assert.ok(settled.every((x) => x.subagent.endedAt > 0 && x.subagent.step === undefined));
    // Folded into the run's map they replace the running entries.
    const map = new Map();
    for (const a of emitted) applyActivity(map, a);
    for (const a of settled) applyActivity(map, a);
    assert.deepEqual([...map.values()].map((x) => x.subagent.state), ['stopped', 'stopped', 'completed', 'stopped']);
  }
});

test('Codex agent states from the JSON stream: interrupted is stopped, errored stays failed', () => {
  const ev = (status) => ({ type: 'item.completed', item: { id: 'i1', type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: ['th-1'], agents_states: { 'th-1': { status, message: null } }, status: 'completed' } });
  assert.equal(nativeActivities('codex', ev('interrupted'))[0].subagent.state, 'stopped');
  assert.equal(nativeActivities('codex', ev('errored'))[0].subagent.state, 'failed');
});

test('pending scan, stream interruption, and matching child collapse into one stopped panel card', () => {
  resetCliAgents();
  const map = new Map();
  const ctx = { chatId: 91, root: '/p' };
  const publish = (a) => { applyActivity(map, a); trackCliAgents(ctx, [...map.values()], 9000); };
  publish(rolloutActivities(scanOf(agent('context', { id: 'pending:p:context', threadId: null, state: 'starting' })))[0]);
  for (const a of nativeActivities('codex', { type: 'item.completed', item: { id: 'interrupt', type: 'collab_tool_call', tool: 'interrupt_agent', receiver_thread_ids: ['thread-context'], agents_states: { 'thread-context': { status: 'interrupted' } } } })) publish(a);
  assert.equal(map.size, 2); // The stream knows the thread before the scan resolves the pending task.
  publish(rolloutActivities(scanOf(agent('context', { state: 'running', turnStartedAtMs: 1000, toolUses: 3, tokens: { total: 500 } })))[0]);
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].subagent.state, 'stopped');
  assert.equal(getCliAgents().length, 1);
  assert.equal(getCliAgents()[0].state, 'stopped');
  assert.equal(getCliAgents()[0].tokens, 500);
  resetCliAgents();
});
