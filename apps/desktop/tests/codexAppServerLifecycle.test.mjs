// Native-subagent lifecycle over the Codex app-server: one state model for start / progress / completion / failure /
// interruption / shutdown, a neutral `unknown` when observation is lost, no ghost `running` after a disconnect, and no
// duplicate cards after a reconnect. Protocol fixtures only (no real Codex run): see the notes in TASKS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createReducer, runAppServerTurn } from '../src/providers/codexAppServer.ts';
import { applyActivity } from '../src/providers/activities.ts';

register('./helpers/hooks.mjs', import.meta.url);
await import('./helpers/apiStub.mjs');
const { trackCliAgents, getCliAgents, resetCliAgents } = await import('../src/agent/cliAgents.ts');

const ROOT = 'thr-root';
const note = (method, params) => ({ jsonrpc: '2.0', method, params });
const item = (method, threadId, it) => note(method, { threadId, turnId: 't1', item: it });
const spawn = (id, ids) => ({
  type: 'collabAgentToolCall',
  id,
  tool: 'spawnAgent',
  status: 'completed',
  senderThreadId: ROOT,
  receiverThreadIds: ids,
  prompt: 'Review the parser',
  model: 'gpt-5.1-codex',
  agentsStates: Object.fromEntries(ids.map((i) => [i, { status: 'running', message: null }])),
});
const turnDone = (threadId, status = 'completed', extra = {}) =>
  note('turn/completed', { threadId, turn: { id: 't1', status, items: [], ...extra } });
const usage = (threadId, total, last) =>
  note('thread/tokenUsage/updated', {
    threadId,
    turnId: 't1',
    tokenUsage: {
      total: {
        inputTokens: total,
        outputTokens: 1,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: total,
      },
      last: { inputTokens: last, outputTokens: 1, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: last },
    },
  });

function fakeConn(script) {
  let cb = () => {};
  let close;
  const closed = new Promise((r) => {
    close = r;
  });
  const written = [];
  const conn = {
    written,
    emit: (m) => cb(m),
    async write(line) {
      const m = JSON.parse(line);
      written.push(m);
      if (m.id !== undefined && m.method) {
        const r = script(m, conn);
        if (r !== 'silent')
          queueMicrotask(() => {
            cb({ jsonrpc: '2.0', id: m.id, result: r?.result ?? {} });
            for (const n of r?.then ?? []) cb(n);
          });
      }
    },
    onMessage(f) {
      cb = f;
    },
    closed,
    kill() {
      close(null);
    },
    stderr: () => '',
    exit: (code) => close(code),
  };
  return conn;
}
const base =
  (then = []) =>
  (m) => {
    if (m.method === 'initialize') return { result: { userAgent: 'codex' } };
    if (m.method === 'thread/start' || m.method === 'thread/resume') return { result: { thread: { id: ROOT } } };
    if (m.method === 'turn/start') return { result: { turn: { id: 't1' } }, then };
  };
const handlers = (extra = {}) => {
  const out = { acts: new Map() };
  return {
    out,
    h: {
      onText() {},
      onActivity: (a) => {
        applyActivity(out.acts, a);
        extra.onActivity?.(out.acts);
      },
      ...extra.h,
    },
  };
};
const P = { prompt: 'hi', model: 'gpt-5.1-codex', access: 'auto', mode: 'agent', cwd: '/proj' };
const agentsOf = (out) =>
  Object.fromEntries([...out.acts.values()].filter((a) => a.subagent).map((a) => [a.subagent.agentId, a]));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('wait limit: children that never reported are "unknown" (neutral), not running and not completed', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(
    base([item('item/completed', ROOT, spawn('s1', ['ca', 'cb'])), turnDone('ca'), turnDone(ROOT)]),
  );
  const r = await runAppServerTurn(conn, P, { ...h, childWaitMs: 30 });
  const a = agentsOf(out);
  assert.equal(a.ca.subagent.state, 'completed');
  assert.equal(a.cb.subagent.state, 'unknown');
  assert.equal(a.cb.status, 'unknown');
  assert.ok(a.cb.subagent.endedAt, 'a settled card has an end time, so no timer keeps counting');
  assert.deepEqual(r.unreported, ['cb']);
  assert.equal(r.error, '');
});

test('process crash while children run: stopped (runtime confirmed gone), the turn fails, nothing stays running', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(base([item('item/completed', ROOT, spawn('s1', ['ca', 'cb'])), turnDone(ROOT)]));
  const p = runAppServerTurn(conn, P, h);
  await tick();
  conn.emit(turnDone('ca'));
  conn.exit(139);
  const r = await p;
  const a = agentsOf(out);
  assert.equal(a.ca.subagent.state, 'completed', 'a child that reported before the crash keeps its verdict');
  assert.equal(a.cb.subagent.state, 'stopped');
  assert.match(a.cb.subagent.result, /exited/);
  assert.ok(![...out.acts.values()].some((x) => x.status === 'running'));
});

test('parent turn failed or interrupted with running children: settled as stopped, not left running', async () => {
  for (const status of ['failed', 'interrupted']) {
    const { out, h } = handlers();
    const conn = fakeConn(
      base([
        item('item/completed', ROOT, spawn('s1', ['ca'])),
        turnDone(ROOT, status, status === 'failed' ? { error: { message: 'model error' } } : {}),
      ]),
    );
    const r = await runAppServerTurn(conn, P, h);
    assert.equal(agentsOf(out).ca.subagent.state, 'stopped', status);
    assert.deepEqual(r.unreported, ['ca']);
    assert.equal(r.error, status === 'failed' ? 'model error' : '');
  }
});

test('user stop settles running children as stopped before the AbortError', async () => {
  const { out, h } = handlers();
  const ac = new AbortController();
  const conn = fakeConn(base([item('item/completed', ROOT, spawn('s1', ['ca'])), turnDone(ROOT)]));
  const p = runAppServerTurn(conn, P, { ...h, signal: ac.signal });
  await tick();
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(agentsOf(out).ca.subagent.state, 'stopped');
});

test('thread/closed ends a running child as stopped; a reported child is untouched; a held closed frame is replayed', () => {
  const rd = createReducer(ROOT);
  const map = new Map();
  const feed = (m) => {
    for (const e of rd.onMessage(m)) if (e.kind === 'activity') applyActivity(map, e.activity);
  };
  feed(note('thread/closed', { threadId: 'late' }));
  feed(item('item/completed', ROOT, spawn('s1', ['ca', 'cb', 'late'])));
  feed(turnDone('cb'));
  feed(note('thread/closed', { threadId: 'ca' }));
  feed(note('thread/closed', { threadId: 'cb' }));
  const st = (id) => [...map.values()].find((a) => a.subagent?.agentId === id).subagent.state;
  assert.equal(st('ca'), 'stopped');
  assert.equal(st('cb'), 'completed');
  assert.equal(st('late'), 'stopped');
  assert.deepEqual(rd.running(), []);
});

test('settle leaves finished children alone and returns nothing when none run', () => {
  const rd = createReducer(ROOT);
  rd.onMessage(item('item/completed', ROOT, spawn('s1', ['ca'])));
  rd.onMessage(turnDone('ca', 'failed', { error: { message: 'x' } }));
  assert.deepEqual(rd.settle('unknown', 'n'), []);
});

test('a provider report after an "unknown" verdict replaces it; progress frames do not revive it', () => {
  const rd = createReducer(ROOT);
  const map = new Map();
  const feed = (effects) => {
    for (const e of effects) if (e.kind === 'activity') applyActivity(map, e.activity);
  };
  feed(rd.onMessage(item('item/completed', ROOT, spawn('s1', ['ca']))));
  feed(rd.settle('unknown', 'lost'));
  const get = () => [...map.values()].find((a) => a.subagent?.agentId === 'ca');
  assert.equal(get().subagent.state, 'unknown');
  assert.equal(get().status, 'unknown');
  feed(rd.onMessage(usage('ca', 10, 10)));
  assert.equal(get().subagent.state, 'unknown');
  feed(rd.onMessage(turnDone('ca')));
  assert.equal(get().subagent.state, 'completed');
});

test('reconnect/resume: a child re-announced by the next connection stays one panel entry (no duplicate cards)', async () => {
  resetCliAgents();
  const track = (acts) => trackCliAgents({ chatId: 7, root: '/p' }, [...acts.values()]);
  // Turn 1: the process dies with the child running.
  const one = handlers({ onActivity: track });
  const c1 = fakeConn(base([item('item/completed', ROOT, spawn('s1', ['ca'])), turnDone(ROOT)]));
  const p1 = runAppServerTurn(c1, P, one.h);
  await tick();
  c1.exit(1);
  await p1;
  assert.deepEqual(
    getCliAgents().map((e) => [e.agentId, e.state]),
    [['ca', 'stopped']],
  );
  // Turn 2 resumes the thread; the same child thread is announced again under a new item id, then finishes.
  const two = handlers({ onActivity: track });
  const again = {
    type: 'subAgentActivity',
    id: 'again',
    kind: 'started',
    agentThreadId: 'ca',
    agentPath: '/root/review',
  };
  const c2 = fakeConn(base([item('item/started', ROOT, again), turnDone('ca'), turnDone(ROOT)]));
  const r2 = await runAppServerTurn(c2, { ...P, session: ROOT }, two.h);
  assert.equal(c2.written.find((m) => m.method === 'thread/resume').params.threadId, ROOT);
  assert.deepEqual(r2.unreported, []);
  assert.deepEqual(
    getCliAgents().map((e) => [e.agentId, e.state]),
    [['ca', 'completed']],
  );
});

test('Codex agent status mapping: shutdown stops (not completes), notFound fails, interrupted stops', () => {
  const rd = createReducer(ROOT);
  const map = new Map();
  for (const [id, status] of [
    ['a', 'shutdown'],
    ['b', 'notFound'],
    ['c', 'interrupted'],
  ]) {
    const wait = {
      type: 'collabAgentToolCall',
      id: `w${id}`,
      tool: 'wait',
      status: 'completed',
      senderThreadId: ROOT,
      receiverThreadIds: [id],
      agentsStates: { [id]: { status, message: null } },
    };
    for (const e of rd.onMessage(item('item/completed', ROOT, wait)))
      if (e.kind === 'activity') applyActivity(map, e.activity);
  }
  const st = (id) => [...map.values()].find((a) => a.subagent?.agentId === id).subagent.state;
  assert.deepEqual([st('a'), st('b'), st('c')], ['stopped', 'failed', 'stopped']);
});
