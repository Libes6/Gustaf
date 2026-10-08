// Follow-ups for per-turn agents (one process per turn: cursor-agent CLI, `codex exec`, the Cursor SDK sidecar): a
// clarification sent while the turn runs ends it softly (graceful stop of the process), keeps what it produced, leaves
// the message queued, and the agent loop continues with a new turn that resumes the same session (T3 `restart_active`).
// Stop still throws an interrupted error that carries the partial output. Processes are fakes (tests/helpers/shellStub.mjs).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { shell, fakeProcess, installSignals } = await import('./helpers/shellStub.mjs');
installSignals();
const { cliAdapter } = await import('../src/providers/cli.ts');
const { runAgent } = await import('../src/agent/agent.ts');
const { partialOf } = await import('../src/providers/lifecycle.ts');
const { restartableTurn } = await import('../src/providers/turnRestart.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');
const { setPlatformForTests } = await import('../src/lib/platform.ts');

setPlatformForTests('macos');

const user = (text) => ({ role: 'user', parts: [{ type: 'text', text }] });
const textOf = (m) =>
  m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('');

/** The chat queue as useChatRun exposes it: take is non-destructive, storing a taken message removes it. */
function chatQueue() {
  const q = { items: [], wakes: new Set(), taken: 0, delivered: [] };
  q.wake = () => [...q.wakes].forEach((cb) => cb());
  q.push = (text) => (q.items.push(user(text)), q.wake());
  q.onWake = (cb) => (q.wakes.add(cb), () => q.wakes.delete(cb));
  q.take = async () => (q.taken++, [...q.items]);
  q.stored = (m) => {
    if (m.role === 'user') q.items = q.items.filter((i) => textOf(i) !== textOf(m));
  };
  return q;
}

/** Handler for the fake shell: `which cursor-agent` answers, every spawned turn goes to `turns` in order. */
function scriptShell(turns) {
  const procs = [];
  shell.spawned.length = 0;
  shell.handler = {
    execute: async () => ({ code: 0, stdout: '/usr/local/bin/cursor-agent\n', stderr: '' }),
    spawn: (cmd) => {
      const p = fakeProcess(turns[procs.length]?.proc);
      procs.push(p);
      const run = turns[procs.length - 1]?.run;
      if (run) setTimeout(() => run(p, cmd), 0);
      return p;
    },
  };
  return procs;
}

const cursorCfg = { id: 'cur', name: 'Cursor CLI', kind: 'cli', cli: 'cursor-agent' };
const delta = (text, session) => ({
  type: 'assistant',
  timestamp_ms: Date.now(),
  session_id: session,
  message: { content: [{ type: 'text', text }] },
});
const toolStarted = (session) => ({
  type: 'tool_call',
  subtype: 'started',
  call_id: 'call-1',
  session_id: session,
  tool_call: { readToolCall: { args: { path: 'a.ts' } } },
});

beforeEach(() => {
  state.reset();
  saveRulesConfig(DEFAULT_RULES);
});

test('cursor-agent: a clarification restarts the turn softly and the loop resumes the session with it', async () => {
  const q = chatQueue();
  const procs = scriptShell([
    {
      // Turn 1 works until it is stopped; SIGTERM ends it like the real CLI (no result line, exit 143).
      run: async (p) => {
        p.line({ type: 'system', subtype: 'init', session_id: 'sess-1' });
        p.line(delta('Looking at the parser', 'sess-1'));
        p.line(toolStarted('sess-1'));
        await sleep(5);
        q.push('Use the new API instead');
      },
    },
    {
      run: async (p) => {
        p.line(delta('Switched to the new API', 'sess-1'));
        p.line({ type: 'result', session_id: 'sess-1', result: 'Switched to the new API', is_error: false });
        p.exit(0);
      },
    },
  ]);
  const stored = [];
  const out = await runAgent({
    root: mkdtempSync(join(tmpdir(), 'restart-')),
    history: [user('Fix the parser')],
    adapter: cliAdapter(cursorCfg),
    providerId: 'cur',
    model: 'default',
    access: 'auto',
    computerUse: false,
    allowlist: [],
    signal: new AbortController().signal,
    takeClarifications: q.take,
    followUpWake: q.onWake,
    onText: () => {},
    onMessage: async (m) => {
      stored.push(m);
      q.stored(m);
    },
    approve: async () => true,
  });
  assert.ok(out, 'the run ends normally');
  assert.equal(procs.length, 2, 'one process per turn');
  assert.deepEqual(procs[0].signals, ['term'], 'the first turn got a graceful stop, no kill');
  const [first, clar, last] = stored;

  assert.equal(first.role, 'assistant');
  assert.equal(textOf(first), 'Looking at the parser', 'the partial text is kept');
  assert.equal(first.meta.responseId, 'sess-1', 'with the session to resume');
  assert.equal(first.parts.find((p) => p.type === 'activity').status, 'unknown', 'a running card ends as unknown');
  assert.equal(clar.role, 'user');
  assert.equal(textOf(clar), 'Use the new API instead', 'the clarification is stored once, by the loop');
  assert.equal(stored.filter((m) => m.role === 'user').length, 1);
  assert.equal(textOf(last), 'Switched to the new API');
  assert.deepEqual(q.items, [], 'the queue is empty afterwards');
  const second = shell.spawned[1].script;
  assert.match(second, /--resume'? '?sess-1/, 'the next turn resumes the same session');
  assert.match(second, /Use the new API instead/);
});

test('cursor-agent: Stop throws an interrupted error with the partial output; no restart without a follow-up', async () => {
  scriptShell([
    {
      run: async (p) => {
        p.line({ type: 'system', subtype: 'init', session_id: 'sess-2' });
        p.line(delta('Half done', 'sess-2'));
        p.line(toolStarted('sess-2'));
      },
    },
  ]);
  const ac = new AbortController();
  const q = chatQueue();
  const turn = cliAdapter(cursorCfg).turn({
    system: 'sys',
    messages: [user('go')],
    model: 'default',
    signal: ac.signal,
    onText: () => {},
    followUp: { onWake: q.onWake, take: q.take, delivered: async () => assert.fail('nothing is delivered') },
  });
  await sleep(10);
  ac.abort();
  const e = await turn.then(
    () => assert.fail('a stopped turn throws'),
    (err) => err,
  );
  assert.equal(e.name, 'AbortError');
  const partial = partialOf(e);
  assert.equal(textOf(partial), 'Half done');
  assert.equal(partial.responseId, 'sess-2');
  assert.equal(partial.parts.find((p) => p.type === 'activity').status, 'unknown');
});

test('a follow-up after the terminal event does not restart; the loop takes it after the turn', async () => {
  const q = chatQueue();
  const procs = scriptShell([
    {
      // The CLI printed its result but lingers (a background shell): the follow-up must not kill the finished turn.
      run: async (p) => {
        p.line(delta('Done', 'sess-3'));
        p.line({ type: 'result', session_id: 'sess-3', result: 'Done', is_error: false });
        q.push('one more');
        await sleep(5);
        p.exit(0);
      },
    },
  ]);
  const out = await cliAdapter(cursorCfg).turn({
    system: 'sys',
    messages: [user('go')],
    model: 'default',
    signal: new AbortController().signal,
    onText: () => {},
    followUp: { onWake: q.onWake, take: q.take, delivered: async () => assert.fail('nothing is delivered') },
  });
  assert.equal(textOf(out), 'Done');
  assert.deepEqual(procs[0].signals, [], 'no stop was sent');
  assert.equal(q.items.length, 1, 'the message stays queued for the loop');
});

test('restartableTurn: the run signal is a stop, a follow-up is a restart; a disabled one never restarts', async () => {
  const q = chatQueue();
  const stop = new AbortController();
  const a = restartableTurn({ signal: stop.signal, followUp: q });
  q.push('x');
  await sleep(1);
  assert.equal(a.signal.aborted, true);
  assert.equal(a.restarted(), true);
  assert.equal(a.stopped(), false);
  await a.close();
  assert.equal(q.items.length, 1, 'the restart leaves the message queued');

  const b = restartableTurn({ signal: stop.signal, followUp: q }, { enabled: false });
  q.wake();
  await sleep(1);
  assert.equal(b.signal.aborted, false);
  stop.abort();
  assert.equal(b.signal.aborted, true);
  assert.equal(b.stopped(), true);
  assert.equal(b.restarted(), false);
  await b.close();
});

test('codex exec: a clarification restarts the turn; the thread id and the finished messages are kept', async () => {
  state.settings.set('codexTransport', JSON.stringify('exec'));
  state.settings.set('readCodexSessions', JSON.stringify(false));
  const q = chatQueue();
  const procs = scriptShell([
    {
      run: async (p) => {
        p.line({ type: 'thread.started', thread_id: 'thr-7' });
        p.line({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Reading files' } });
        await sleep(5);
        q.push('skip the tests');
      },
    },
  ]);
  const out = await cliAdapter({ id: 'cx', name: 'Codex', kind: 'cli', cli: 'codex' }).turn({
    system: 'sys',
    messages: [user('go')],
    model: 'default',
    signal: new AbortController().signal,
    onText: () => {},
    followUp: q,
  });
  assert.deepEqual(procs[0].signals, ['term']);
  assert.equal(out.responseId, 'thr-7');
  assert.match(textOf(out), /Reading files/);
  assert.equal(q.items.length, 1);
});
