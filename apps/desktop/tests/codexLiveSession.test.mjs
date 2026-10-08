// Codex app-server as a live session (providers/codexAppServer.ts `createAppServerSession`, providers/codexLive.ts): one
// process and one loaded thread serve many turns; follow-ups are steered into the running turn; Stop interrupts natively and
// keeps the session; a process that died between turns is replaced by one that resumes the thread. Scripted connections
// that follow the codex-cli 0.160.1 app-server schema (`codex app-server generate-json-schema`) and what a live run showed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServerUnavailable, createAppServerSession, runAppServerTurn } from '../src/providers/codexAppServer.ts';
import { codexLiveTurn, liveSignature } from '../src/providers/codexLive.ts';
import { createSessionManager } from '../src/providers/sessionManager.ts';
import { applyActivity } from '../src/providers/activities.ts';

const ROOT = 'thr-root';
const note = (method, params) => ({ jsonrpc: '2.0', method, params });
const item = (method, threadId, it, turnId = 't1') => note(method, { threadId, turnId, item: it });
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
const turnStarted = (threadId, id) => note('turn/started', { threadId, turn: { id, status: 'inProgress', items: [] } });
const turnDone = (threadId, id, status = 'completed') =>
  note('turn/completed', { threadId, turn: { id, status, items: [] } });
const delta = (text, turnId = 't1') =>
  note('item/agentMessage/delta', { threadId: ROOT, turnId, itemId: `m-${turnId}`, delta: text });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * A scripted app-server. `script(request, conn)` returns `{ result, then }` (answer, then notifications), `{ error }`, or
 * 'silent' (never answered). By default it starts and resumes ROOT and gives each turn/start the next turn id.
 */
function fakeConn(script = () => undefined) {
  let cb = () => {};
  let close;
  const closed = new Promise((r) => {
    close = r;
  });
  const written = [];
  let killed = 0;
  let turns = 0;
  const conn = {
    written,
    get killed() {
      return killed;
    },
    methods: () => written.filter((m) => m.method).map((m) => m.method),
    emit: (m) => cb(m),
    async write(line) {
      const m = JSON.parse(line);
      written.push(m);
      if (m.id === undefined || !m.method) return;
      let r = script(m, conn);
      if (r === undefined) {
        if (m.method === 'initialize') r = { result: { userAgent: 'codex' } };
        else if (m.method === 'thread/start' || m.method === 'thread/resume') r = { result: { thread: { id: ROOT } } };
        else if (m.method === 'turn/start') {
          const id = `t${++turns}`;
          r = { result: { turn: { id, status: 'inProgress', items: [] } }, then: [turnStarted(ROOT, id)] };
        } else r = { result: {} };
      }
      if (r === 'silent') return;
      queueMicrotask(() => {
        if (r.error) cb({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: r.error } });
        else cb({ jsonrpc: '2.0', id: m.id, result: r.result ?? {} });
        for (const n of r.then ?? []) cb(n);
      });
    },
    onMessage(f) {
      cb = f;
    },
    closed,
    kill() {
      killed++;
      close(null);
    },
    stderr: () => '',
    exit: (code) => close(code),
  };
  return conn;
}

const handlers = (extra = {}) => {
  const out = { text: '', acts: new Map(), raw: [] };
  return {
    out,
    h: {
      onText: (s) => {
        out.text += s;
      },
      onActivity: (a) => {
        out.raw.push(a);
        applyActivity(out.acts, a);
      },
      ...extra,
    },
  };
};
const P = { prompt: 'hi', model: 'gpt-5.1-codex', access: 'auto', mode: 'agent', cwd: '/proj' };
const agent = (out, id) => [...out.acts.values()].find((a) => a.subagent?.agentId === id);

/** A follow-up channel like the chat queue: `take` reads the head, `delivered` removes what the agent got. */
function channel() {
  const queue = [];
  let wake;
  const ch = {
    queue,
    got: [],
    send(text) {
      queue.push({ role: 'user', parts: [{ type: 'text', text }] });
      wake?.();
    },
    onWake(cb) {
      wake = cb;
      return () => {
        wake = undefined;
      };
    },
    async take() {
      return [...queue];
    },
    async delivered(msgs) {
      ch.got.push(...msgs);
      queue.splice(0, msgs.length);
    },
  };
  return ch;
}

test('two turns on one process: the second is only a turn/start on the loaded thread (no initialize, no resume)', async () => {
  const conn = fakeConn();
  const s = createAppServerSession(conn);
  const one = handlers();
  const p1 = s.turn(P, one.h);
  await tick();
  conn.emit(delta('first'));
  conn.emit(turnDone(ROOT, 't1'));
  const r1 = await p1;
  assert.equal(r1.session, ROOT);
  assert.equal(one.out.text, 'first');
  assert.equal(s.alive(), true);
  assert.equal(conn.killed, 0, 'the process outlives the turn');
  const two = handlers();
  const p2 = s.turn({ ...P, session: ROOT, model: 'gpt-5.2-codex', reasoning: 'high' }, two.h);
  await tick();
  conn.emit(delta('second', 't2'));
  conn.emit(turnDone(ROOT, 't2'));
  await p2;
  assert.equal(two.out.text, 'second', 'per-turn state (text separation) is reset');
  assert.deepEqual(conn.methods(), ['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/start']);
  const second = conn.written.filter((m) => m.method === 'turn/start')[1].params;
  assert.equal(second.model, 'gpt-5.2-codex', 'model and effort are per-turn parameters');
  assert.equal(second.effort, 'high');
});

test('a follow-up is steered into the running turn (turn/steer with the expected turn id) and marked delivered', async () => {
  const conn = fakeConn();
  const s = createAppServerSession(conn);
  const ch = channel();
  const p = s.turn(P, { ...handlers().h, followUp: ch });
  await tick();
  ch.send('also check the tests');
  await tick();
  const steer = conn.written.find((m) => m.method === 'turn/steer');
  assert.deepEqual(steer.params, {
    threadId: ROOT,
    expectedTurnId: 't1',
    input: [{ type: 'text', text: 'also check the tests' }],
  });
  assert.equal(ch.got.length, 1);
  assert.equal(ch.queue.length, 0);
  conn.emit(turnDone(ROOT, 't1'));
  await p;
});

test('a steer the server rejects (the turn already ended) leaves the message queued for the next turn', async () => {
  // Real codex-cli 0.160.1 answers a late steer with -32600 "no active turn to steer".
  const conn = fakeConn((m) => (m.method === 'turn/steer' ? { error: 'no active turn to steer' } : undefined));
  const s = createAppServerSession(conn);
  const ch = channel();
  const p = s.turn(P, { ...handlers().h, followUp: ch });
  await tick();
  ch.send('late');
  await tick();
  assert.ok(conn.methods().includes('turn/steer'));
  assert.equal(ch.got.length, 0);
  assert.equal(ch.queue.length, 1, 'still queued');
  conn.emit(turnDone(ROOT, 't1'));
  await p;
  assert.equal(s.alive(), true);
});

test('stop: turn/interrupt ends the turn natively, the process is kept and serves the next turn', async () => {
  const conn = fakeConn((m) =>
    m.method === 'turn/interrupt' ? { result: {}, then: [turnDone(ROOT, m.params.turnId, 'interrupted')] } : undefined,
  );
  const s = createAppServerSession(conn);
  const ac = new AbortController();
  const usage = [];
  const p = s.turn(P, { ...handlers().h, signal: ac.signal, onUsage: (u) => usage.push(u) });
  await tick();
  conn.emit(delta('partial'));
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.deepEqual(conn.written.find((m) => m.method === 'turn/interrupt').params, { threadId: ROOT, turnId: 't1' });
  assert.equal(conn.killed, 0);
  assert.equal(s.alive(), true);
  const p2 = s.turn({ ...P, session: ROOT }, handlers().h);
  await tick();
  conn.emit(turnDone(ROOT, 't2'));
  assert.equal((await p2).error, '');
});

test('stop: also interrupts running children; an interrupt that times out stops the process (session broken)', async () => {
  // Children answer their interrupt; the root never does.
  const conn = fakeConn((m) =>
    m.method === 'turn/interrupt' && m.params.threadId !== ROOT
      ? { result: {}, then: [turnDone(m.params.threadId, m.params.turnId, 'interrupted')] }
      : undefined,
  );
  const s = createAppServerSession(conn);
  const ac = new AbortController();
  const { out, h } = handlers();
  const p = s.turn(P, { ...h, signal: ac.signal, interruptWaitMs: 40 });
  await tick();
  conn.emit(item('item/completed', ROOT, spawn('s1', ['ca', 'cb'])));
  conn.emit(turnStarted('ca', 'ca-t1'));
  conn.emit(turnStarted('cb', 'cb-t1'));
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const targets = conn.written.filter((m) => m.method === 'turn/interrupt').map((m) => m.params.turnId);
  assert.deepEqual(targets.sort(), ['ca-t1', 'cb-t1', 't1']);
  assert.equal(conn.killed, 1);
  assert.equal(s.alive(), false);
  assert.equal(agent(out, 'ca').subagent.state, 'stopped');
});

test('stop while children of a completed parent turn still run: they are interrupted and the session stays usable', async () => {
  const conn = fakeConn((m) =>
    m.method === 'turn/interrupt'
      ? { result: {}, then: [turnDone(m.params.threadId, m.params.turnId, 'interrupted')] }
      : undefined,
  );
  const s = createAppServerSession(conn);
  const ac = new AbortController();
  const { out, h } = handlers();
  const p = s.turn(P, { ...h, signal: ac.signal });
  await tick();
  conn.emit(item('item/completed', ROOT, spawn('s1', ['ca'])));
  conn.emit(turnStarted('ca', 'ca-t1'));
  conn.emit(turnDone(ROOT, 't1'));
  await tick();
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.deepEqual(
    conn.written.filter((m) => m.method === 'turn/interrupt').map((m) => m.params),
    [{ threadId: 'ca', turnId: 'ca-t1' }],
  );
  assert.equal(agent(out, 'ca').subagent.state, 'stopped');
  assert.equal(s.alive(), true);
});

test('a follow-up while children outlive the parent turn ends the turn; the children are followed into the next turn', async () => {
  const conn = fakeConn((m) => (m.method === 'turn/steer' ? { error: 'no active turn to steer' } : undefined));
  const s = createAppServerSession(conn);
  const ch = channel();
  const one = handlers();
  const p1 = s.turn(P, { ...one.h, followUp: ch });
  await tick();
  conn.emit(item('item/completed', ROOT, spawn('s1', ['ca'])));
  conn.emit(turnStarted('ca', 'ca-t1'));
  conn.emit(turnDone(ROOT, 't1'));
  await tick();
  ch.send('next question');
  const r1 = await p1;
  assert.deepEqual(r1.background, ['ca']);
  assert.deepEqual(r1.unreported, []);
  assert.equal(agent(one.out, 'ca').subagent.state, 'running', 'not settled: the live session still follows it');
  assert.equal(s.backgroundWork(), true, 'keeps the session pinned');
  // Between turns the child reports progress; then turn 2 starts and the child finishes during it.
  conn.emit(item('item/started', 'ca', { type: 'commandExecution', id: 'x', command: 'ls', status: 'inProgress' }));
  const two = handlers();
  const p2 = s.turn({ ...P, session: ROOT }, two.h);
  await tick();
  conn.emit(item('item/completed', 'ca', { type: 'agentMessage', id: 'r', text: 'parser is fine' }, 'ca-t1'));
  conn.emit(turnDone('ca', 'ca-t1'));
  conn.emit(turnDone(ROOT, 't2'));
  await p2;
  const ca = agent(two.out, 'ca');
  assert.equal(ca.subagent.state, 'completed');
  assert.equal(ca.subagent.title, 'Review the parser', 'the card from turn 1 is whole in turn 2');
  assert.match(ca.subagent.result, /parser is fine/);
  assert.equal(s.backgroundWork(), false);
});

test('children wait: still bounded, and a child update reaches the turn while it waits', async () => {
  const conn = fakeConn();
  const s = createAppServerSession(conn);
  const { out, h } = handlers();
  const p = s.turn(P, { ...h, childWaitMs: 40 });
  await tick();
  conn.emit(item('item/completed', ROOT, spawn('s1', ['ca'])));
  conn.emit(turnDone(ROOT, 't1'));
  const r = await p;
  assert.deepEqual(r.unreported, ['ca']);
  assert.equal(agent(out, 'ca').subagent.state, 'unknown');
  assert.equal(s.backgroundWork(), true, 'an unknown child may still run in the live process');
  conn.emit(turnDone('ca', 'ca-t1'));
  assert.equal(s.backgroundWork(), false);
});

test('exec fallback is only offered before the turn was accepted', async () => {
  // Exits before answering turn/start: nothing ran.
  const early = fakeConn((m) => (m.method === 'turn/start' ? 'silent' : undefined));
  const p1 = runAppServerTurn(early, P, handlers().h);
  await tick();
  early.exit(1);
  await assert.rejects(p1, (e) => e instanceof AppServerUnavailable);
  // Exits after turn/start was accepted and output streamed: an error of the turn, never a reason to rerun the prompt.
  const late = fakeConn();
  const { out, h } = handlers();
  const p2 = runAppServerTurn(late, P, h);
  await tick();
  late.emit(delta('working'));
  late.exit(139);
  const r = await p2;
  assert.match(r.error, /exited with 139/);
  assert.equal(out.text, 'working');
});

test('live sessions: one process per chat, the next turn reuses it; a process that died between turns is replaced and resumes the thread with its children', async () => {
  const sessions = createSessionManager({ idleMs: 60_000 });
  const conns = [];
  const resumeTurns = [{ id: 't1', items: [{ ...spawn('s1', ['ca']), receiverThreadIds: ['ca'] }] }];
  const open = async () => {
    const c = fakeConn((m) =>
      m.method === 'thread/resume' ? { result: { thread: { id: ROOT, turns: resumeTurns } } } : undefined,
    );
    conns.push(c);
    return c;
  };
  const turn = async (params, h, after) => {
    const p = codexLiveTurn({
      open,
      executable: '/bin/codex',
      providerId: 'codex',
      chatId: 7,
      cwd: '/proj',
      params,
      handlers: h,
      sessions,
    });
    await tick();
    after();
    return p;
  };
  const c = () => conns[conns.length - 1];
  await turn(P, handlers().h, () => c().emit(turnDone(ROOT, 't1')));
  await turn({ ...P, session: ROOT, model: 'gpt-5.2-codex' }, handlers().h, () => c().emit(turnDone(ROOT, 't2')));
  assert.equal(conns.length, 1, 'model change: same process');
  assert.deepEqual(conns[0].methods(), ['initialize', 'initialized', 'thread/start', 'turn/start', 'turn/start']);
  // The process dies while idle: the next turn opens a new one that resumes the thread.
  conns[0].exit(1);
  await tick();
  const { out, h } = handlers();
  await turn({ ...P, session: ROOT }, h, () => {
    // The parent talks to the child from its history: the child's new turn is known, not held as a stranger.
    c().emit(turnStarted('ca', 'ca-t2'));
    c().emit(turnDone('ca', 'ca-t2'));
    c().emit(turnDone(ROOT, 't1'));
  });
  assert.equal(conns.length, 2);
  assert.equal(conns[1].written.find((m) => m.method === 'thread/resume').params.threadId, ROOT);
  assert.equal(agent(out, 'ca').subagent.state, 'completed', 'seeded from the resumed history');
  // A turn that does not continue the live thread (history edited): a fresh process and a new thread.
  await turn({ ...P }, handlers().h, () => c().emit(turnDone(ROOT, 't1')));
  assert.equal(conns.length, 3);
  assert.ok(conns[1].killed >= 1, 'the replaced process is stopped');
  await sessions.releaseAll();
});

test('launch signature: model and effort changes reuse the process; back to defaults or a goal effort do not', () => {
  const a = liveSignature('/bin/codex', { ...P, reasoning: 'low' });
  assert.equal(a, liveSignature('/bin/codex', { ...P, model: 'other', reasoning: 'high', access: 'full' }));
  assert.notEqual(a, liveSignature('/bin/codex', { ...P, model: undefined, reasoning: 'low' }));
  assert.notEqual(a, liveSignature('/bin/codex', { ...P }));
  assert.notEqual(a, liveSignature('/bin/codex', { ...P, reasoning: 'low', goal: { objective: 'x' } }));
  assert.notEqual(a, liveSignature('/usr/local/bin/codex', { ...P, reasoning: 'low' }));
});

test('a reused session whose process died after the liveness check is replaced once, transparently', async () => {
  const sessions = createSessionManager({ idleMs: 60_000 });
  const conns = [];
  const open = async () => {
    const c = fakeConn();
    conns.push(c);
    return c;
  };
  const run = (params) =>
    codexLiveTurn({
      open,
      executable: 'codex',
      providerId: 'codex',
      chatId: 1,
      params,
      handlers: handlers().h,
      sessions,
    });
  const p1 = run(P);
  await tick();
  conns[0].emit(turnDone(ROOT, 't1'));
  await p1;
  // Dies exactly when the next turn/start is written (alive() was still true at acquire time).
  const dying = conns[0];
  const write = dying.write;
  dying.write = async (line) => {
    if (JSON.parse(line).method === 'turn/start') return dying.exit(1);
    return write(line);
  };
  const p2 = run({ ...P, session: ROOT });
  await tick(40);
  conns[1].emit(turnDone(ROOT, 't1'));
  assert.equal((await p2).error, '');
  assert.equal(conns.length, 2);
  assert.ok(conns[1].methods().includes('thread/resume'));
  await sessions.releaseAll();
});

test('native goal on a live session: the goal runs on the loaded thread; Stop pauses it and interrupts its turn', async () => {
  const conn = fakeConn((m) => {
    if (m.method === 'thread/goal/set' && m.params.objective)
      return { result: { goal: {} }, then: [turnStarted(ROOT, 'g1')] };
    if (m.method === 'turn/interrupt') return { result: {}, then: [turnDone(ROOT, m.params.turnId, 'interrupted')] };
    return undefined;
  });
  const s = createAppServerSession(conn);
  const p1 = s.turn(P, handlers().h);
  await tick();
  conn.emit(turnDone(ROOT, 't1'));
  await p1;
  const ac = new AbortController();
  const p2 = s.turn({ ...P, session: ROOT, goal: { objective: 'ship it' } }, { ...handlers().h, signal: ac.signal });
  await tick();
  ac.abort();
  await assert.rejects(p2, (e) => e.name === 'AbortError');
  const sets = conn.written.filter((m) => m.method === 'thread/goal/set').map((m) => m.params);
  assert.deepEqual(sets, [
    { threadId: ROOT, objective: 'ship it' },
    { threadId: ROOT, status: 'paused' },
  ]);
  assert.deepEqual(conn.written.find((m) => m.method === 'turn/interrupt').params, { threadId: ROOT, turnId: 'g1' });
  assert.equal(s.alive(), true);
  assert.equal(conn.methods().filter((m) => m === 'initialize').length, 1);
});

test('stop while the thread is still being resumed: no interrupt needed, the connection is given up at once', async () => {
  const conn = fakeConn((m) => (m.method === 'thread/resume' ? 'silent' : undefined));
  const s = createAppServerSession(conn);
  const ac = new AbortController();
  const p = s.turn({ ...P, session: ROOT }, { ...handlers().h, signal: ac.signal });
  await tick();
  const t0 = Date.now();
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(Date.now() - t0 < 500);
  assert.equal(conn.killed, 1);
  assert.equal(s.alive(), false);
  assert.ok(!conn.methods().includes('turn/start'));
});
