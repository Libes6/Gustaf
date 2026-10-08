// Claude Code as a live session (src/providers/claudeSession.ts), against events recorded from the real CLI
// (claude 2.1.292, `-p --input-format stream-json --output-format stream-json --replay-user-messages`; see
// tests/fixtures/claude-live-session.jsonl). A fake process replays a fixture step when the adapter writes a user
// message; `$1`, `$2` in the fixture stand for the uuids of the messages written during that step.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { runClaudeLiveTurn, LiveSessionUnavailable, resetLiveSupport, claudeLiveArgs } =
  await import('../src/providers/claudeSession.ts');
const { createSessionManager } = await import('../src/providers/sessionManager.ts');
const { partialOf } = await import('../src/providers/lifecycle.ts');

const STEPS = new Map();
for (const line of readFileSync(new URL('./fixtures/claude-live-session.jsonl', import.meta.url), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const { step, event } = JSON.parse(line);
  if (!STEPS.has(step)) STEPS.set(step, []);
  STEPS.get(step).push(event);
}
const step = (name) => STEPS.get(name).map((e) => structuredClone(e));

/** A JsonProcess stand-in: records writes, emits events, exits on demand. */
function fakeProc(args) {
  let listener;
  const queued = [];
  let close;
  const p = {
    pid: 1,
    args,
    writes: [],
    stops: 0,
    gone: false,
    err: '',
    onWrite: undefined,
    closed: new Promise((r) => (close = r)),
    async write(line) {
      const m = JSON.parse(line);
      p.writes.push(m);
      queueMicrotask(() => p.onWrite?.(m));
    },
    onMessage(cb) {
      listener = cb;
      for (const m of queued.splice(0)) cb(m);
    },
    emit(e) {
      if (listener) listener(e);
      else queued.push(e);
    },
    exited: () => p.gone,
    stderr: () => p.err,
    exit(code) {
      if (p.gone) return;
      p.gone = true;
      close(code);
    },
    async stop() {
      p.stops++;
      p.exit(null);
    },
  };
  return p;
}

/** Emits `events` one macrotask apart, replacing `$n` with the uuid of the n-th user message written in this step. */
async function play(proc, events, uuids) {
  for (const e of events) {
    await sleep(0);
    const s = JSON.stringify(e).replace(/"\$(\d)"/g, (_, n) => JSON.stringify(uuids[Number(n) - 1] ?? `missing-${n}`));
    proc.emit(JSON.parse(s));
  }
}

const userWrites = (p) => p.writes.filter((w) => w.type === 'user');

function harness() {
  const sessions = createSessionManager({ idleMs: 60_000 });
  const procs = [];
  let n = 0;
  const deps = {
    sessions,
    open: async ({ args }) => {
      const p = fakeProc(args);
      procs.push(p);
      deps.onOpen?.(p);
      return p;
    },
    rawLogger: async () => ({ raw() {}, debug() {}, unmapped() {}, flush: async () => {} }),
    interruptMs: 2000,
    uuid: () => `u-${++n}`,
  };
  const ctx = {
    providerId: 'claude-1',
    executable: async () => '/usr/local/bin/claude',
    levels: () => ['low', 'medium', 'high'],
    attachments: { save: async () => ({ dir: '/att/7', files: [] }), clear: async () => {} },
  };
  const history = [];
  const turn = (text, o = {}) => {
    history.push({ role: 'user', parts: [{ type: 'text', text }] });
    const ac = o.controller ?? new AbortController();
    const out = { text: '', activities: [], limits: [] };
    const run = runClaudeLiveTurn(
      {
        system: 'SYS',
        messages: [...history],
        tools: [],
        model: 'haiku',
        cwd: '/work',
        chatId: 7,
        access: 'auto',
        mode: o.mode ?? 'agent',
        signal: ac.signal,
        onText: (d) => (out.text += d),
        onActivity: (a) => out.activities.push(a),
        onLimits: (w) => out.limits.push(...w),
        followUp: o.followUp,
      },
      ctx,
      deps,
    ).then(
      (r) => {
        history.push({ role: 'assistant', parts: r.parts, meta: { provider: 'claude-1', responseId: r.responseId } });
        return r;
      },
      (e) => {
        const p = partialOf(e);
        if (p)
          history.push({ role: 'assistant', parts: p.parts, meta: { provider: 'claude-1', responseId: p.responseId } });
        throw e;
      },
    );
    return { run, out, ac };
  };
  /** Answers every user message written to `proc` with the next fixture step. */
  const answer = (proc, names) => {
    const queue = [...names];
    proc.onWrite = (m) => {
      if (m.type !== 'user' || !queue.length) return;
      void play(proc, step(queue.shift()), [m.uuid]);
    };
  };
  return { sessions, procs, deps, ctx, turn, answer, history };
}

beforeEach(() => resetLiveSupport());

test('launch flags: stream-json input, replayed user messages, --resume only when resuming', () => {
  const args = claudeLiveArgs({ model: 'haiku', access: 'auto', mode: 'agent', session: 's1' });
  for (const f of ['-p', '--output-format', '--verbose', '--include-partial-messages', '--replay-user-messages'])
    assert.ok(args.includes(f), f);
  assert.deepEqual(args.slice(args.indexOf('--input-format'), args.indexOf('--input-format') + 2), [
    '--input-format',
    'stream-json',
  ]);
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 's1']);
  assert.ok(!claudeLiveArgs({ access: 'auto' }).includes('--resume'));
});

test('one process serves consecutive turns; each turn ends on its result, not on exit', async () => {
  const h = harness();
  h.deps.onOpen = (p) => h.answer(p, ['turn-1', 'turn-2']);
  const a = h.turn('Reply with exactly: ONE');
  const r1 = await a.run;
  assert.equal(a.out.text, 'ONE');
  assert.equal(r1.responseId, 'sess-live-1');
  assert.ok(r1.usage && r1.usage.output > 0);
  assert.ok(a.out.limits.length, 'rate_limit_event reaches onLimits');
  const b = h.turn('Reply with exactly: TWO');
  const r2 = await b.run;
  assert.equal(b.out.text, 'TWO');
  assert.equal(r2.parts.at(-1).text, 'TWO');
  assert.equal(h.procs.length, 1, 'the second turn reused the process');
  assert.equal(h.procs[0].stops, 0);
  const [m1, m2] = userWrites(h.procs[0]);
  assert.equal(m1.message.content, 'SYS\n\nReply with exactly: ONE');
  assert.equal(m2.message.content, 'SYS\n\nReply with exactly: TWO');
  assert.equal(m1.priority, undefined);
  assert.ok(!h.procs[0].args.includes('--resume'), 'a new chat starts a new Claude session');
  await h.sessions.releaseAll();
});

test('a launch-flag change starts a new process that resumes the same Claude session', async () => {
  const h = harness();
  h.deps.onOpen = (p) => h.answer(p, h.procs.length === 1 ? ['turn-1'] : ['respawn-resume']);
  await h.turn('Reply with exactly: ONE').run;
  const plan = h.turn('Reply with exactly: PLAN', { mode: 'plan' });
  await plan.run;
  assert.equal(plan.out.text, 'PLAN');
  assert.equal(h.procs.length, 2);
  assert.equal(h.procs[0].stops, 1, 'the old process was released');
  const args = h.procs[1].args;
  assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', 'sess-live-1']);
  assert.deepEqual(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2), [
    '--permission-mode',
    'plan',
  ]);
  await h.sessions.releaseAll();
});

test('a history that continues another Claude session than the live one respawns on the right session', async () => {
  const h = harness();
  h.deps.onOpen = (p) => h.answer(p, ['turn-1', 'turn-2']);
  await h.turn('Reply with exactly: ONE').run;
  // The chat was branched: its last assistant message names an older session.
  h.history.at(-1).meta.responseId = 'sess-older';
  await h.turn('Reply with exactly: TWO').run;
  assert.equal(h.procs.length, 2);
  assert.ok(h.procs[1].args.includes('sess-older'));
  await h.sessions.releaseAll();
});

test('a follow-up is written into the running turn with priority "next" and answered by the same result', async () => {
  const h = harness();
  const events = step('steer-next');
  const cut = events.findIndex((e) => e.type === 'system' && e.subtype === 'task_notification');
  let wake;
  const queue = [];
  const delivered = [];
  const followUp = {
    onWake: (cb) => ((wake = cb), () => (wake = undefined)),
    take: async () => queue.splice(0),
    delivered: async (msgs) => void delivered.push(...msgs),
  };
  h.deps.onOpen = (p) => {
    const uuids = [];
    p.onWrite = async (m) => {
      if (m.type !== 'user') return;
      uuids.push(m.uuid);
      if (uuids.length === 1) {
        await play(p, events.slice(0, cut), uuids);
        // The user sends a message while the tool runs.
        queue.push({ role: 'user', parts: [{ type: 'text', text: 'Also end your reply with the word KIWI.' }] });
        wake?.();
      } else await play(p, events.slice(cut), uuids);
    };
  };
  const t = h.turn('Use the Bash tool to run exactly: sleep 4 && echo SLEPT. Then reply with its output.', {
    followUp,
  });
  const r = await t.run;
  const writes = userWrites(h.procs[0]);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].priority, 'next');
  assert.equal(writes[1].message.content, 'Also end your reply with the word KIWI.');
  assert.equal(delivered.length, 1);
  assert.equal(t.out.text, 'SLEPT\n\nKIWI');
  const bash = r.parts.find((p) => p.type === 'activity' && p.name === 'Bash');
  assert.equal(bash.status, 'success');
  await h.sessions.releaseAll();
});

test('a result that comes before the CLI took a follow-up does not end the turn', async () => {
  const h = harness();
  const queue = [{ role: 'user', parts: [{ type: 'text', text: 'and B' }] }];
  const followUp = { onWake: () => () => {}, take: async () => queue.splice(0), delivered: async () => {} };
  h.deps.onOpen = (p) => {
    const uuids = [];
    p.onWrite = async (m) => {
      if (m.type !== 'user') return;
      uuids.push(m.uuid);
      if (uuids.length < 2) return;
      // The first run ends before the CLI takes the follow-up, then a second run answers it.
      const run = (uuid, text, i) => [
        { type: 'system', subtype: 'init', session_id: 's' },
        { type: 'user', isReplay: true, uuid, message: { role: 'user', content: '…' }, session_id: 's' },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
        { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's', result_index: i },
      ];
      await play(p, run(uuids[0], 'A', 0), []);
      await play(p, run(uuids[1], 'B', 1), []);
    };
  };
  const t = h.turn('A', { followUp });
  const r = await t.run;
  assert.equal(t.out.text, 'A\n\nB', 'the runs are separated');
  assert.equal(r.responseId, 's');
  await h.sessions.releaseAll();
});

test('Stop interrupts softly: partial text and session id are kept and the process serves the next turn', async () => {
  const h = harness();
  const events = step('interrupt');
  const cut = events.findIndex((e) => e.type === 'control_response');
  h.deps.onOpen = (p) => {
    let turn = 0;
    p.onWrite = async (m) => {
      if (m.type === 'user' && ++turn === 1) {
        // Recorded: the answer streamed up to 28 before the interrupt took effect.
        await play(p, events.slice(0, cut), [m.uuid]);
      } else if (m.type === 'control_request') {
        assert.deepEqual(m.request, { subtype: 'interrupt' });
        await play(p, events.slice(cut), []);
      } else if (m.type === 'user') await play(p, step('after-interrupt'), [m.uuid]);
    };
  };
  const t = h.turn('Count from 1 to 80, one number per line, nothing else.');
  await sleep(30);
  t.ac.abort();
  const err = await t.run.catch((e) => e);
  assert.equal(err.name, 'AbortError');
  const partial = partialOf(err);
  assert.equal(partial.responseId, 'sess-live-1');
  assert.match(partial.parts.find((p) => p.type === 'text').text, /^1\n2\n3\n[\s\S]*\n28$/);
  assert.equal(h.procs[0].stops, 0, 'the process was not killed');
  const next = h.turn('What was the last number you wrote?');
  await next.run;
  assert.equal(next.out.text, '28');
  assert.equal(h.procs.length, 1, 'the interrupted session was reused');
  await h.sessions.releaseAll();
});

test('Stop kills the process when the interrupt gets no result in time, and the next turn resumes in a new one', async () => {
  const h = harness();
  h.deps.interruptMs = 40;
  h.deps.onOpen = (p) => {
    if (h.procs.length === 1)
      p.onWrite = async (m) => {
        if (m.type === 'user') await play(p, step('interrupt').slice(0, 3), [m.uuid]);
        // control_request: no answer (a hung tool)
      };
    else h.answer(p, ['after-interrupt']);
  };
  const t = h.turn('Count');
  await sleep(20);
  t.ac.abort();
  const err = await t.run.catch((e) => e);
  assert.equal(err.name, 'AbortError');
  assert.equal(partialOf(err).responseId, 'sess-live-1');
  assert.equal(h.procs[0].stops >= 1, true, 'the process tree was stopped');
  await h.turn('next').run;
  assert.equal(h.procs.length, 2);
  assert.ok(h.procs[1].args.includes('sess-live-1'), 'the new process resumes the session');
  await h.sessions.releaseAll();
});

test('a process that dies mid-turn fails the turn and is never reused', async () => {
  const h = harness();
  h.deps.onOpen = (p) => {
    if (h.procs.length === 1)
      p.onWrite = async (m) => {
        if (m.type !== 'user') return;
        await play(p, step('turn-1').slice(0, 3), [m.uuid]);
        p.err = 'Error: something broke';
        p.exit(1);
      };
    else h.answer(p, ['turn-2']);
  };
  await assert.rejects(h.turn('Reply ONE').run, /something broke/);
  const next = h.turn('Reply TWO');
  await next.run;
  assert.equal(h.procs.length, 2, 'a new process was started');
  await h.sessions.releaseAll();
});

test('an error result fails the turn; an auth error adds the login hint and drops the session', async () => {
  const h = harness();
  h.deps.onOpen = (p) => {
    p.onWrite = async (m) => {
      if (m.type !== 'user') return;
      await play(
        p,
        [
          { type: 'system', subtype: 'init', session_id: 's' },
          { type: 'user', isReplay: true, uuid: m.uuid, message: { role: 'user', content: 'x' }, session_id: 's' },
          {
            type: 'result',
            subtype: 'success',
            is_error: true,
            result: 'Invalid API key · Please run /login',
            session_id: 's',
          },
        ],
        [],
      );
    };
  };
  await assert.rejects(h.turn('x').run, /Invalid API key[\s\S]*claude auth login/);
  assert.equal(h.procs[0].stops, 1, 'the session was released');
  await h.sessions.releaseAll();
});

test('a CLI that cannot start a live session falls back to the per-turn path, once per executable', async () => {
  const h = harness();
  h.deps.onOpen = (p) => {
    p.err = "error: unknown option '--replay-user-messages'";
    setTimeout(() => p.exit(1), 0);
  };
  const err = await h.turn('x').run.catch((e) => e);
  assert.ok(err instanceof LiveSessionUnavailable);
  assert.match(err.message, /unknown option/);
  const again = await h.turn('y').run.catch((e) => e);
  assert.ok(again instanceof LiveSessionUnavailable);
  assert.equal(h.procs.length, 1, 'the second turn did not try to start a process');
  await h.sessions.releaseAll();
});

test('background tasks keep the session busy after its turn; the wake run between turns clears it', async () => {
  const h = harness();
  let session;
  const sessions = h.sessions;
  h.deps.sessions = {
    acquire: async (key, sig, open) => {
      const lease = await sessions.acquire(key, sig, open);
      session = lease.session;
      return lease;
    },
  };
  h.deps.onOpen = (p) => h.answer(p, ['background-launch']);
  const t = h.turn('Run sleep 6 in the background');
  await t.run;
  assert.equal(t.out.text, 'STARTED');
  assert.equal(session.backgroundWork(), true, 'the background shell pins the session');
  await play(h.procs[0], step('background-wake').slice(0, 4), []);
  assert.equal(session.background.size, 0);
  assert.equal(session.backgroundWork(), true, 'the CLI is answering the task notification on its own');
  await play(h.procs[0], step('background-wake').slice(4), []);
  assert.equal(session.backgroundWork(), false);
  assert.equal(t.out.text, 'STARTED', 'the wake run does not leak into the finished turn');
  await sessions.releaseAll();
});

test('a one-off start failure falls back for that turn only', async () => {
  const h = harness();
  h.deps.onOpen = (p) => {
    if (h.procs.length === 1) {
      p.err = 'spawn failed: EAGAIN';
      setTimeout(() => p.exit(1), 0);
    } else h.answer(p, ['turn-1']);
  };
  assert.ok((await h.turn('x').run.catch((e) => e)) instanceof LiveSessionUnavailable);
  await h.turn('Reply with exactly: ONE').run;
  assert.equal(h.procs.length, 2, 'the next turn tried the live session again');
  await h.sessions.releaseAll();
});
