import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AppServerUnavailable,
  createReducer,
  execItem,
  runAppServerTurn,
  sandboxFor,
  threadRequest,
  turnRequest,
} from '../src/providers/codexAppServer.ts';
import { applyActivity } from '../src/providers/activities.ts';

// Fixtures follow the app-server schema (T3 Code's generated `ServerNotification`): camelCase items, `threadId` on every notification.
const ROOT = 'thr-root';
const note = (method, params) => ({ jsonrpc: '2.0', method, params });
const item = (method, threadId, it) => note(method, { threadId, turnId: 't1', item: it });
const spawn = (id, ids, extra = {}) => ({
  type: 'collabAgentToolCall',
  id,
  tool: 'spawnAgent',
  status: 'completed',
  senderThreadId: ROOT,
  receiverThreadIds: ids,
  prompt: 'Review the parser',
  model: 'gpt-5.1-codex',
  agentsStates: Object.fromEntries(ids.map((i) => [i, { status: 'running', message: null }])),
  ...extra,
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
        outputTokens: total / 10,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: total * 1.1,
      },
      last: {
        inputTokens: last,
        outputTokens: last / 10,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: last * 1.1,
      },
    },
  });

/** A scripted connection: `script` gets every request and returns what the server does next (responses are added by the harness). */
function fakeConn(script) {
  let cb = () => {};
  let close;
  const closed = new Promise((r) => {
    close = r;
  });
  const written = [];
  let killed = 0;
  const conn = {
    written,
    get killed() {
      return killed;
    },
    emit: (m) => cb(m),
    async write(line) {
      const m = JSON.parse(line);
      written.push(m);
      if (m.id !== undefined && m.method) {
        const r = script(m, conn);
        if (r?.error) queueMicrotask(() => cb({ jsonrpc: '2.0', id: m.id, error: { code: -1, message: r.error } }));
        else if (r !== 'silent')
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
      killed++;
      close(null);
    },
    stderr: () => '',
    exit: (code) => close(code),
  };
  return conn;
}
const base =
  (extra = {}) =>
  (m, conn) => {
    if (m.method === 'initialize') return { result: { userAgent: 'codex' } };
    if (m.method === 'thread/start' || m.method === 'thread/resume') return { result: { thread: { id: ROOT } } };
    if (m.method === 'turn/start') return { result: { turn: { id: 't1' } }, then: extra.then ?? [] };
  };
const handlers = () => {
  const out = { text: '', acts: new Map(), usage: undefined, raw: [] };
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
      onUsage: (u) => {
        out.usage = u;
      },
    },
  };
};
const P = { prompt: 'hi', model: 'gpt-5.1-codex', access: 'auto', mode: 'agent', cwd: '/proj' };

test('requests: thread start/resume and turn params carry sandbox, effort, images and never ask for approval', () => {
  assert.deepEqual(threadRequest(P), {
    method: 'thread/start',
    params: { cwd: '/proj', model: 'gpt-5.1-codex', approvalPolicy: 'never', sandbox: 'workspace-write' },
  });
  assert.equal(threadRequest({ ...P, session: 'abc' }).method, 'thread/resume');
  assert.equal(threadRequest({ ...P, session: 'abc' }).params.threadId, 'abc');
  const t = turnRequest('abc', { ...P, reasoning: 'high', images: ['/a.png'] });
  assert.deepEqual(t.input, [
    { type: 'text', text: 'hi' },
    { type: 'localImage', path: '/a.png' },
  ]);
  assert.equal(t.effort, 'high');
  assert.deepEqual(t.sandboxPolicy, { type: 'workspaceWrite' });
  assert.equal(sandboxFor('full', 'plan').mode, 'read-only');
  assert.equal(sandboxFor('full', 'agent').mode, 'danger-full-access');
  assert.equal(sandboxFor('readonly', 'agent').mode, 'read-only');
});

test('a plain turn streams text, shows commands as activities and reports the usage of this turn only', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(
    base({
      then: [
        usage(ROOT, 1000, 1000), // first model call of the thread: nothing before it
        item('item/started', ROOT, {
          type: 'commandExecution',
          id: 'c1',
          command: 'ls',
          commandActions: [],
          cwd: '/proj',
          status: 'inProgress',
        }),
        item('item/completed', ROOT, {
          type: 'commandExecution',
          id: 'c1',
          command: 'ls',
          commandActions: [],
          cwd: '/proj',
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: 'a\nb',
        }),
        note('item/agentMessage/delta', { threadId: ROOT, turnId: 't1', itemId: 'm1', delta: 'Hello ' }),
        note('item/agentMessage/delta', { threadId: ROOT, turnId: 't1', itemId: 'm1', delta: 'world' }),
        item('item/completed', ROOT, { type: 'agentMessage', id: 'm1', text: 'Hello world' }),
        usage(ROOT, 1500, 500),
        turnDone(ROOT),
      ],
    }),
  );
  const r = await runAppServerTurn(conn, P, h);
  assert.equal(out.text, 'Hello world', 'streamed text is not repeated by the completed item');
  assert.equal(r.session, ROOT);
  assert.equal(r.error, '');
  const cmd = out.acts.get('c1');
  assert.equal(cmd.status, 'success');
  assert.match(cmd.output, /a\nb/);
  assert.deepEqual(out.usage, { input: 1500, output: 150, cached: 0, cacheWrite: 0, reasoning: 0 });
  assert.ok(conn.killed >= 1, 'the process is stopped when the turn ends');
});

test('a message that never streamed arrives whole; an unstreamed one is not duplicated', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(
    base({ then: [item('item/completed', ROOT, { type: 'agentMessage', id: 'm9', text: 'Whole' }), turnDone(ROOT)] }),
  );
  await runAppServerTurn(conn, P, h);
  assert.equal(out.text, 'Whole');
});

test('a spawn of two agents makes two entries with their model; child frames that came before registration are replayed', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(
    base({
      then: [
        note('thread/started', {
          thread: {
            id: 'ca',
            parentThreadId: ROOT,
            model: 'gpt-5.1-codex',
            agentRole: 'explorer',
            agentNickname: 'Ada',
          },
        }),
        // The child starts working before the parent's spawn item is completed.
        note('turn/started', { threadId: 'ca', turn: { id: 'x', status: 'inProgress', items: [] } }),
        item('item/started', 'ca', {
          type: 'commandExecution',
          id: 'cc1',
          command: 'rg parser',
          commandActions: [],
          cwd: '/p',
          status: 'inProgress',
        }),
        item('item/started', ROOT, spawn('s1', ['ca', 'cb'], { status: 'inProgress' })),
        item('item/completed', ROOT, spawn('s1', ['ca', 'cb'])),
        turnDone(ROOT),
      ],
    }),
  );
  const r = await runAppServerTurn(conn, P, { ...h, childWaitMs: 20 });
  const subs = [...out.acts.values()].filter((a) => a.subagent);
  assert.equal(subs.length, 2);
  const ca = subs.find((a) => a.subagent.agentId === 'ca').subagent;
  assert.equal(ca.model, 'gpt-5.1-codex');
  assert.equal(ca.role, 'explorer');
  assert.equal(ca.toolUses, 1, 'the held command of the child was replayed');
  assert.match(ca.step, /rg parser/);
  assert.deepEqual(r.unreported.sort(), ['ca', 'cb'], 'the parent turn ending does not complete a running child');
});

test('child status is monotone; only a new turn of that child reopens it', () => {
  const rd = createReducer(ROOT);
  const map = new Map();
  const feed = (m) => {
    for (const e of rd.onMessage(m)) if (e.kind === 'activity') applyActivity(map, e.activity);
  };
  feed(item('item/completed', ROOT, spawn('s1', ['ca'])));
  const get = () => [...map.values()].find((a) => a.subagent?.agentId === 'ca').subagent;
  feed(note('turn/started', { threadId: 'ca', turn: { id: 'x' } }));
  feed(item('item/completed', 'ca', { type: 'agentMessage', id: 'cm', text: 'Found 3 bugs' }));
  feed(turnDone('ca'));
  assert.equal(get().state, 'completed');
  assert.match(get().result, /Found 3 bugs/);
  assert.deepEqual(rd.running(), []);
  // A late tool frame and a late token update must not revive it.
  feed(
    item('item/started', 'ca', {
      type: 'commandExecution',
      id: 'late',
      command: 'ls',
      commandActions: [],
      cwd: '/',
      status: 'inProgress',
    }),
  );
  feed(usage('ca', 10, 10));
  assert.equal(get().state, 'completed');
  // SendMessage to the finished agent starts a new turn of the same thread: running again, then finished again.
  feed(note('turn/started', { threadId: 'ca', turn: { id: 'y' } }));
  assert.equal(get().state, 'running');
  assert.deepEqual(rd.running(), ['ca']);
  feed(turnDone('ca', 'interrupted'));
  assert.equal(get().state, 'stopped');
});

test('children that outlive the parent turn are waited for until they report an end', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(base({ then: [item('item/completed', ROOT, spawn('s1', ['ca', 'cb'])), turnDone(ROOT)] }));
  const p = runAppServerTurn(conn, P, h);
  let settled = false;
  p.then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, 'the turn stays open while children run');
  conn.emit(turnDone('ca'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false);
  conn.emit(item('item/completed', 'cb', { type: 'agentMessage', id: 'x', text: 'late result' }));
  conn.emit(turnDone('cb'));
  const r = await p;
  assert.deepEqual(r.unreported, []);
  const by = (id) => [...out.acts.values()].find((a) => a.subagent?.agentId === id).subagent;
  assert.equal(by('ca').state, 'completed');
  assert.match(by('cb').result, /late result/);
});

test('waiting for children is bounded and stoppable, and does not decide their fate', async () => {
  const mk = () => fakeConn(base({ then: [item('item/completed', ROOT, spawn('s1', ['ca'])), turnDone(ROOT)] }));
  const r = await runAppServerTurn(mk(), P, { ...handlers().h, childWaitMs: 40 });
  assert.deepEqual(r.unreported, ['ca'], 'never reported an end');
  const ac = new AbortController();
  const p = runAppServerTurn(mk(), P, { ...handlers().h, signal: ac.signal });
  await new Promise((r2) => setTimeout(r2, 30));
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  const c3 = mk();
  const q = runAppServerTurn(c3, P, handlers().h);
  await new Promise((r2) => setTimeout(r2, 30));
  c3.exit(1);
  assert.deepEqual((await q).unreported, ['ca'], 'a process that exits ends the wait');
});

test('a child that errors or is interrupted ends in its own state without failing the parent', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(
    base({
      then: [
        item('item/completed', ROOT, spawn('s1', ['ca', 'cb'])),
        turnDone('ca', 'failed', { error: { message: 'boom' } }),
        turnDone('cb', 'interrupted'),
        note('item/agentMessage/delta', { threadId: ROOT, turnId: 't1', itemId: 'm1', delta: 'done' }),
        turnDone(ROOT),
      ],
    }),
  );
  const r = await runAppServerTurn(conn, P, h);
  const by = (id) => [...out.acts.values()].find((a) => a.subagent?.agentId === id).subagent;
  assert.equal(by('ca').state, 'failed');
  assert.match(by('ca').result, /boom/);
  assert.equal(by('cb').state, 'stopped');
  assert.equal(r.error, '');
  assert.deepEqual(r.unreported, []);
});

test('frames of unknown threads are bounded and never become entries', () => {
  const rd = createReducer(ROOT);
  for (let i = 0; i < 500; i++) rd.onMessage(note('turn/started', { threadId: `ghost${i}`, turn: { id: 'x' } }));
  assert.ok(rd.held <= 50);
  assert.deepEqual(rd.onMessage(note('turn/started', { threadId: 'ghost1', turn: { id: 'x' } })), []);
});

test('approval requests: declined without a handler, asked with one; unknown server requests get an error', async () => {
  const reqs = [
    {
      jsonrpc: '2.0',
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: ROOT, itemId: 'c', command: 'rm -rf x', reason: 'outside the sandbox' },
    },
    {
      jsonrpc: '2.0',
      id: 79,
      method: 'item/fileChange/requestApproval',
      params: { threadId: ROOT, itemId: 'f', grantRoot: '/etc' },
    },
    { jsonrpc: '2.0', id: 78, method: 'item/tool/requestUserInput', params: { threadId: ROOT } },
  ];
  let conn = fakeConn(base({ then: [...reqs, turnDone(ROOT)] }));
  await runAppServerTurn(conn, P, handlers().h);
  const reply = (c, id) => c.written.find((m) => m.id === id && !m.method);
  assert.deepEqual(reply(conn, 77).result, { decision: 'decline' });
  assert.deepEqual(reply(conn, 79).result, { decision: 'decline' });
  assert.equal(reply(conn, 78).error.code, -32601);
  const asked = [];
  conn = fakeConn(base({ then: [...reqs.slice(0, 2), turnDone(ROOT)] }));
  await runAppServerTurn(conn, P, {
    ...handlers().h,
    onApproval: async (a) => {
      asked.push(a);
      return a.command === 'rm -rf x';
    },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked[0].command, 'rm -rf x');
  assert.equal(asked[0].reason, 'outside the sandbox');
  assert.match(asked[1].reason, /\/etc/);
  assert.deepEqual(reply(conn, 77).result, { decision: 'accept' });
  assert.deepEqual(reply(conn, 79).result, { decision: 'decline' });
});

test('approvals are only requested when the caller can ask, and only in workspace-write', () => {
  assert.equal(threadRequest({ ...P, approvals: true }).params.approvalPolicy, 'on-request');
  assert.equal(threadRequest(P).params.approvalPolicy, 'never');
  assert.equal(threadRequest({ ...P, approvals: true, access: 'full' }).params.approvalPolicy, 'never');
  assert.equal(threadRequest({ ...P, approvals: true, mode: 'plan' }).params.approvalPolicy, 'never');
  assert.equal(turnRequest('t', { ...P, approvals: true }).approvalPolicy, 'on-request');
});

test('a failed turn reports its message; an interrupted turn is not an error', async () => {
  let c = fakeConn(base({ then: [turnDone(ROOT, 'failed', { error: { message: 'rate limited' } })] }));
  assert.equal((await runAppServerTurn(c, P, handlers().h)).error, 'rate limited');
  c = fakeConn(base({ then: [turnDone(ROOT, 'interrupted')] }));
  assert.equal((await runAppServerTurn(c, P, handlers().h)).error, '');
  c = fakeConn(
    base({
      then: [
        note('error', { error: { message: 'retrying' }, willRetry: true }),
        note('error', { error: { message: 'fatal' }, willRetry: false }),
      ],
    }),
  );
  assert.equal((await runAppServerTurn(c, P, handlers().h)).error, 'fatal');
});

test('a crash mid-turn is an error and settles unreported children as stopped, never running or completed', async () => {
  const { out, h } = handlers();
  const conn = fakeConn(base({ then: [item('item/completed', ROOT, spawn('s1', ['ca']))] }));
  const p = runAppServerTurn(conn, P, h);
  await new Promise((r) => setTimeout(r, 20));
  conn.exit(139);
  const r = await p;
  assert.match(r.error, /exited with 139/);
  assert.deepEqual(r.unreported, ['ca']);
});

test('stop: an interrupt that does not end the turn in time stops the process; rejects with AbortError', async () => {
  const ac = new AbortController();
  const conn = fakeConn(base({ then: [] }));
  const p = runAppServerTurn(conn, P, { ...handlers().h, signal: ac.signal, interruptWaitMs: 30 });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(conn.written.some((m) => m.method === 'turn/interrupt' && m.params.turnId === 't1'));
  assert.ok(conn.killed >= 1);
});

test('an app-server that cannot initialize is "unavailable" so the caller can fall back to exec', async () => {
  const conn = fakeConn((m) => (m.method === 'initialize' ? { error: 'unknown variant' } : {}));
  await assert.rejects(runAppServerTurn(conn, P, handlers().h), (e) => e instanceof AppServerUnavailable);
  const dead = fakeConn(() => 'silent');
  setTimeout(() => dead.exit(1), 10);
  await assert.rejects(runAppServerTurn(dead, P, handlers().h), (e) => e instanceof AppServerUnavailable);
});

test('execItem: command, file change and MCP items take the exec shape the activity cards read', () => {
  assert.equal(
    execItem({ type: 'commandExecution', id: 'a', command: 'x', status: 'declined', exitCode: null }).status,
    'failed',
  );
  assert.deepEqual(
    execItem({
      type: 'fileChange',
      id: 'f',
      status: 'completed',
      changes: [{ path: 'a.ts', kind: 'update', diff: 'x' }],
    }).changes,
    [{ path: 'a.ts', kind: 'update' }],
  );
  assert.equal(
    execItem({ type: 'mcpToolCall', id: 'm', server: 's', tool: 't', arguments: {}, status: 'inProgress' }).status,
    'in_progress',
  );
});

// Recorded from a real run: codex-cli 0.160.1, "spawn two subagents in parallel, wait for both" (noise methods dropped, paths anonymized).
import { readFileSync } from 'node:fs';
test('real Codex 0.160.1 run with two subagents: both appear, finish, and no bare wait cards or running leftovers', () => {
  const lines = readFileSync(new URL('./fixtures/codex-app-server-two-agents.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const root = lines.find((m) => m.method === 'thread/started').params.thread.id;
  const rd = createReducer(root);
  const map = new Map();
  let text = '';
  let done;
  for (const m of lines)
    for (const e of rd.onMessage(m)) {
      if (e.kind === 'activity') applyActivity(map, e.activity);
      else if (e.kind === 'text') text += e.text;
      else if (e.kind === 'done') done = e;
    }
  const agents = [...map.values()].filter((a) => a.subagent);
  assert.deepEqual(agents.map((a) => a.subagent.title).sort(), ['arithmetic', 'list files']);
  for (const a of agents) {
    assert.equal(a.subagent.state, 'completed');
    assert.equal(a.status, 'success');
    assert.equal(a.subagent.provider, 'codex');
  }
  assert.match(agents.find((a) => a.subagent.title === 'list files').subagent.step ?? '', /ls -A/);
  assert.equal(map.size, agents.length, 'no generic cards for the empty wait calls');
  assert.deepEqual(rd.running(), []);
  assert.equal(done.status, 'completed');
  assert.match(text, /2\+2 = 4|2\+2 is 4|4/);
});

test('separate agent messages of one turn are separated by a blank line, a continuing message is not', async () => {
  const { out, h } = handlers();
  const d = (itemId, delta) => note('item/agentMessage/delta', { threadId: ROOT, turnId: 't1', itemId, delta });
  const conn = fakeConn(
    base({ then: [d('m1', 'Starting '), d('m1', 'agents.'), d('m2', 'Done: '), d('m2', '4.'), turnDone(ROOT)] }),
  );
  await runAppServerTurn(conn, P, h);
  assert.equal(out.text, 'Starting agents.\n\nDone: 4.');
});

const goalNote = (status, objective = 'Make hello.txt', tokensUsed = 5) =>
  note('thread/goal/updated', {
    threadId: ROOT,
    turnId: 't1',
    goal: { threadId: ROOT, objective, status, tokensUsed, timeUsedSeconds: 3 },
  });
const goalConn = (then) =>
  fakeConn((m) => {
    if (m.method === 'initialize') return { result: {} };
    if (m.method === 'thread/start' || m.method === 'thread/resume') return { result: { thread: { id: ROOT } } };
    if (m.method === 'thread/goal/set') return { result: { goal: {} }, then };
  });
const turnStarted = () => note('turn/started', { threadId: ROOT, turn: { id: 't2', status: 'inProgress', items: [] } });

test("native goal: sets the goal (no turn/start), follows the server's own turns, ends when the goal completes", async () => {
  const { out, h } = handlers();
  const goals = [];
  const conn = goalConn([
    turnStarted(),
    goalNote('active'),
    turnDone(ROOT),
    turnStarted(),
    goalNote('active', undefined, 9),
    goalNote('complete', undefined, 12),
    turnDone(ROOT),
  ]);
  const r = await runAppServerTurn(
    conn,
    { ...P, reasoning: 'high', goal: { objective: 'Make hello.txt' } },
    { ...h, onGoal: (g) => goals.push(g.status + ':' + g.tokensUsed) },
  );
  assert.deepEqual(goals, ['active:5', 'active:9', 'complete:12']);
  assert.equal(r.error, '');
  const methods = conn.written.filter((m) => m.method).map((m) => m.method);
  assert.ok(methods.includes('thread/goal/set'));
  assert.ok(!methods.includes('turn/start'));
  const set = conn.written.find((m) => m.method === 'thread/goal/set');
  assert.deepEqual(set.params, { threadId: ROOT, objective: 'Make hello.txt' });
  assert.equal(
    conn.written.find((m) => m.method === 'thread/start').params.config.model_reasoning_effort,
    'high',
    'the effort travels as thread config',
  );
});

test('native goal: a goal that completes after the last turn ended still ends the run; resume re-activates without a new objective', async () => {
  let conn = goalConn([turnStarted(), turnDone(ROOT), goalNote('blocked')]);
  await runAppServerTurn(conn, { ...P, goal: { objective: 'x', resume: true } }, { ...handlers().h, goalIdleMs: 5000 });
  assert.deepEqual(conn.written.find((m) => m.method === 'thread/goal/set').params, {
    threadId: ROOT,
    status: 'active',
  });
});

test('native goal: an active goal on an idle thread ends the run after the idle wait; a new turn cancels the wait', async () => {
  const goals = [];
  let conn = goalConn([turnStarted(), goalNote('active'), turnDone(ROOT)]);
  const t0 = Date.now();
  await runAppServerTurn(
    conn,
    { ...P, goal: { objective: 'x' } },
    { ...handlers().h, onGoal: (g) => goals.push(g.status), goalIdleMs: 40 },
  );
  assert.ok(Date.now() - t0 >= 35);
  assert.deepEqual(goals, ['active']);
  // The server continues after a pause shorter than the wait: the run goes on to the next turn's end.
  conn = goalConn([turnStarted(), goalNote('active'), turnDone(ROOT)]);
  const p = runAppServerTurn(conn, { ...P, goal: { objective: 'x' } }, { ...handlers().h, goalIdleMs: 60 });
  await new Promise((r) => setTimeout(r, 20));
  conn.emit(turnStarted());
  await new Promise((r) => setTimeout(r, 80));
  let ended = false;
  p.then(() => {
    ended = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ended, false, 'the running turn cancelled the idle wait');
  conn.emit(goalNote('complete'));
  conn.emit(turnDone(ROOT));
  await p;
});

test('native goal: a failed turn ends the run with its error even while the goal is active', async () => {
  const conn = goalConn([
    turnStarted(),
    goalNote('active'),
    turnDone(ROOT, 'failed', { error: { message: 'rate limited' } }),
  ]);
  const r = await runAppServerTurn(conn, { ...P, goal: { objective: 'x' } }, handlers().h);
  assert.equal(r.error, 'rate limited');
});
