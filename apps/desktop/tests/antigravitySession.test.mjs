// Antigravity as a live ACP session (providers/antigravitySession.ts) against a synthetic agent (helpers/fakeAcp.mjs,
// message shapes of the public ACP spec; nothing recorded from the proprietary binary): start sequence, sign-in, probe,
// streaming into text and cards, permissions, Stop, follow-ups, live-session reuse, resume fallback, process exit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeAgent, hangingPrompt, MODEL_OPTION } from './helpers/fakeAcp.mjs';

register('./helpers/hooks.mjs', import.meta.url);
const S = await import('../src/providers/antigravitySession.ts');
const { createSessionManager } = await import('../src/providers/sessionManager.ts');
const { partialOf } = await import('../src/providers/lifecycle.ts');
const { capabilitiesOf } = await import('../src/providers/lifecycle.ts');

const SECRET = 'AIza-secret-key-9999';
const AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=s1';

/** Opens fake agents; `script` may be an object or a function of the launch number. */
function world(script = {}, o = {}) {
  const agents = [];
  const opens = [];
  const deps = {
    method: o.method ?? 'oauth-personal',
    secrets: () => [SECRET],
    open: async (args) => {
      opens.push(args);
      if (o.openError) throw o.openError;
      const a = fakeAgent(typeof script === 'function' ? script(agents.length) : script);
      agents.push(a);
      o.onOpen?.(a, args);
      return a;
    },
  };
  const sessions = createSessionManager({ idleMs: 60_000 });
  const ctx = {
    ...deps,
    providerId: 'agy-1',
    signature: 'sig',
    fallbackCwd: '/tmp/agy',
    sessions,
    interruptMs: o.interruptMs ?? 300,
  };
  const history = [];
  const turn = (text, t = {}) => {
    history.push({ role: 'user', parts: [{ type: 'text', text }] });
    const ac = t.controller ?? new AbortController();
    const out = { text: '', activities: [] };
    const run = S.runAntigravityTurn(
      {
        system: 'SYS',
        messages: [...history],
        tools: [],
        model: t.model ?? 'default',
        reasoning: t.reasoning,
        cwd: '/work',
        chatId: 9,
        access: t.access ?? 'auto',
        mode: 'agent',
        signal: ac.signal,
        onText: (d) => (out.text += d),
        onActivity: (a) => out.activities.push(a),
        approve: t.approve,
        followUp: t.followUp,
      },
      ctx,
    ).then(
      (r) => (
        history.push({ role: 'assistant', parts: r.parts, meta: { provider: 'agy-1', responseId: r.responseId } }),
        r
      ),
      (e) => {
        const p = partialOf(e);
        if (p)
          history.push({ role: 'assistant', parts: p.parts, meta: { provider: 'agy-1', responseId: p.responseId } });
        throw e;
      },
    );
    return { run, out, ac };
  };
  return { agents, opens, deps, ctx, sessions, turn, history };
}

const promptText = (a, n = 0) => a.calls('session/prompt')[n].params.prompt[0].text;

test('start sequence, streaming text and cards, usage and the session id', async () => {
  const w = world({
    onPrompt: (p, a) => {
      a.update(p.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      a.update(p.sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Run ls',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      });
      a.update(p.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'a.txt' } }],
      });
      a.update(p.sessionId, { sessionUpdate: 'plan', entries: [{ content: 'step', status: 'completed' }] });
      a.text(p.sessionId, 'Hello ');
      a.text(p.sessionId, 'world');
      a.update('other-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LEAK' } });
      return {
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 20, thoughtTokens: 5, cachedReadTokens: 40 },
      };
    },
  });
  const { run, out } = w.turn('hi');
  const r = await run;
  const a = w.agents[0];
  assert.deepEqual(a.methods().slice(0, 4), ['initialize', 'authenticate', 'session/new', 'session/prompt']);
  assert.deepEqual(a.calls('authenticate')[0].params, { methodId: 'oauth-personal' });
  assert.deepEqual(a.calls('session/new')[0].params, { cwd: '/work', mcpServers: [] });
  assert.equal(out.text, 'Hello world');
  assert.equal(r.responseId, 's1');
  assert.deepEqual(r.usage, { input: 100, output: 20, cached: 40, cacheWrite: 0, reasoning: 5 });
  const shell = r.parts.find((p) => p.type === 'activity' && p.name === 'shell');
  assert.equal(shell.status, 'success');
  assert.equal(shell.args.command, 'ls');
  assert.equal(shell.output, 'a.txt');
  assert.ok(r.parts.some((p) => p.type === 'activity' && p.name === 'plan'));
  assert.equal(r.parts.at(-1).text, 'Hello world');
  assert.ok(!JSON.stringify(r).includes('thinking') && !JSON.stringify(r).includes('LEAK'));
  assert.match(promptText(a), /^SYS\n\nhi/); // first prompt of an agent session carries the system prompt
  assert.equal(capabilitiesOf({ kind: 'antigravity' }).followUp, 'restart');
});

test('the next turn reuses the live process and does not repeat the system prompt', async () => {
  const w = world();
  await w.turn('one').run;
  await w.turn('two').run;
  assert.equal(w.agents.length, 1);
  assert.equal(w.agents[0].calls('session/prompt').length, 2);
  assert.equal(promptText(w.agents[0], 1), 'two');
  assert.equal(w.agents[0].calls('session/new').length, 1);
  await w.sessions.releaseAll();
  assert.equal(w.agents[0].stops, 1);
});

test('a changed launch signature replaces the process; an edited history opens a fresh session', async () => {
  const w = world();
  await w.turn('one').run;
  w.ctx.signature = 'other';
  await w.turn('two').run;
  assert.equal(w.agents.length, 2);
  // the new process continues the same agent session
  assert.equal(w.agents[1].calls('session/resume')[0].params.sessionId, 's1');
  w.history.splice(1); // the user edited the first reply away: no responseId is left
  await w.turn('three').run;
  assert.equal(w.agents.length, 3);
  assert.equal(w.agents[2].calls('session/new').length, 1);
  assert.match(promptText(w.agents[2]), /USER:\none[\s\S]*three/);
  await w.sessions.releaseAll();
});

test('resume: session/resume when offered; session/load with the history replay muted; new session as the fallback', async () => {
  const prior = (w) =>
    w.history.push(
      { role: 'user', parts: [{ type: 'text', text: 'earlier' }] },
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'answer' }],
        meta: { provider: 'agy-1', responseId: 'old-session' },
      },
    );
  // resume
  let w = world();
  prior(w);
  await w.turn('next').run;
  assert.equal(w.agents[0].calls('session/resume')[0].params.sessionId, 'old-session');
  assert.equal(w.agents[0].calls('session/new').length, 0);
  assert.match(promptText(w.agents[0]), /^SYS\n\nnext/);
  await w.sessions.releaseAll();
  // load: the agent replays the old conversation as updates before answering; it must not reach the chat
  w = world({
    initialize: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] },
    onRequest: (m, r) => {
      if (m.method !== 'session/load') return undefined;
      r.agent.text('old-session', 'REPLAYED OLD TEXT');
      r.reply({ configOptions: [MODEL_OPTION] });
      return 'handled';
    },
  });
  prior(w);
  const { run, out } = w.turn('next');
  await run;
  assert.equal(out.text, 'ok');
  assert.equal(w.agents[0].calls('session/load').length, 1);
  await w.sessions.releaseAll();
  // fallback: the agent does not know the session any more -> new session, whole history replayed
  w = world({
    onRequest: (m, r) => (m.method === 'session/resume' ? (r.fail(-32602, 'unknown session'), 'handled') : undefined),
  });
  prior(w);
  await w.turn('next').run;
  assert.equal(w.agents[0].calls('session/new').length, 1);
  assert.match(
    promptText(w.agents[0]),
    /USER:\nearlier[\s\S]*ASSISTANT:\nanswer[\s\S]*USER:\nnext|earlier[\s\S]*answer[\s\S]*next/,
  );
  await w.sessions.releaseAll();
});

test('model and reasoning are selected on the session through config options', async () => {
  const w = world();
  await w.turn('hi', { model: 'agy-pro', reasoning: 'high' }).run;
  const sets = w.agents[0].calls('session/set_config_option').map((m) => m.params);
  assert.deepEqual(sets, [
    { sessionId: 's1', configId: 'model', value: 'agy-pro' },
    { sessionId: 's1', configId: 'thought', value: 'high' },
  ]);
  const w2 = world();
  await assert.rejects(w2.turn('hi', { model: 'nope' }).run, (e) => e.code === 'model-unavailable');
  await w2.sessions.releaseAll();
  const w3 = world();
  await w3.turn('hi', { model: 'agy-fast' }).run; // already current: nothing to set
  assert.equal(w3.agents[0].calls('session/set_config_option').length, 0);
  await w.sessions.releaseAll();
  await w3.sessions.releaseAll();
});

const permissionParams = (kinds = ['allow_once', 'allow_always', 'reject_once'], id = 'perm1') => ({
  sessionId: 's1',
  toolCall: { toolCallId: id, title: 'Run rm -rf build', kind: 'execute' },
  options: kinds.map((k) => ({ optionId: `o-${k}`, name: k, kind: k })),
});
const askingAgent = (store, params = permissionParams()) => ({
  onPrompt: async (p, a) => {
    store.answer = await a.request('session/request_permission', { ...params, sessionId: p.sessionId });
    return { stopReason: 'end_turn' };
  },
});

test('permission: the approval card decides allow once / reject once; never allow always', async () => {
  const store = {};
  let asked;
  let w = world(askingAgent(store));
  await w.turn('go', { approve: async (req) => ((asked = req), true) }).run;
  assert.deepEqual(store.answer.result, { outcome: { outcome: 'selected', optionId: 'o-allow_once' } });
  assert.equal(asked.kind, 'command');
  assert.equal(asked.command, 'Run rm -rf build');
  await w.sessions.releaseAll();
  w = world(askingAgent(store));
  await w.turn('go', { approve: async () => false }).run;
  assert.deepEqual(store.answer.result, { outcome: { outcome: 'selected', optionId: 'o-reject_once' } });
  await w.sessions.releaseAll();
});

test('permission: read-only denies, full access allows, no approver denies, native questions are cancelled', async () => {
  const store = {};
  const cases = [
    [{ access: 'readonly', approve: async () => true }, 'o-reject_once'],
    [{ access: 'full' }, 'o-allow_once'],
    [{ access: 'auto' }, 'o-reject_once'],
  ];
  for (const [t, want] of cases) {
    const w = world(askingAgent(store));
    await w.turn('go', t).run;
    assert.equal(store.answer.result.outcome.optionId, want, JSON.stringify(Object.keys(t)));
    await w.sessions.releaseAll();
  }
  const w = world(askingAgent(store, permissionParams(['allow_once', 'reject_once'], 'interaction_7')));
  await w.turn('go', { access: 'full' }).run;
  assert.deepEqual(store.answer.result, { outcome: { outcome: 'cancelled' } });
  const only = world(askingAgent(store, permissionParams(['allow_always'])));
  await only.turn('go', { access: 'full' }).run;
  assert.deepEqual(store.answer.result, { outcome: { outcome: 'cancelled' } });
  await w.sessions.releaseAll();
  await only.sessions.releaseAll();
});

test('Stop: session/cancel, interrupted partial output, and the session serves the next turn', async () => {
  const w = world({ onPrompt: hangingPrompt(['partial answer']) });
  const { run, out, ac } = w.turn('long task');
  await sleep(30);
  ac.abort();
  await assert.rejects(run, (e) => {
    const p = partialOf(e);
    assert.equal(e.name, 'AbortError');
    assert.equal(p.responseId, 's1');
    assert.equal(p.parts.at(-1).text, 'partial answer');
    return true;
  });
  assert.equal(out.text, 'partial answer');
  assert.equal(w.agents[0].calls('session/cancel').length, 1);
  assert.equal(w.agents[0].stops, 0, 'a graceful cancel keeps the process');
  w.agents[0].cancelled = false;
  w.agents[0].pendingPrompt = undefined;
  // same process, same session: the next prompt goes to the live agent
  const second = w.turn('after stop');
  await sleep(20);
  w.agents[0].pendingPrompt?.();
  await second.run.catch(() => {});
  assert.equal(w.agents.length, 1);
  assert.equal(w.agents[0].calls('session/prompt').length, 2);
  await w.sessions.releaseAll();
});

test('Stop: an agent that ignores the cancel is stopped after the grace period', async () => {
  const w = world((n) => (n === 0 ? { onPrompt: () => new Promise(() => {}) } : {}), { interruptMs: 40 });
  const { run, ac } = w.turn('x');
  await sleep(20);
  ac.abort();
  await assert.rejects(run, (e) => e.name === 'AbortError');
  assert.equal(w.agents[0].stops, 1);
  await w.turn('again').run;
  assert.equal(w.agents.length, 2, 'a broken session is replaced');
  await w.sessions.releaseAll();
});

test('a pending permission is answered cancelled when the turn is stopped', async () => {
  const store = {};
  const w = world({
    onPrompt: async (p, a) => {
      store.answer = await a.request('session/request_permission', { ...permissionParams(), sessionId: p.sessionId });
      return { stopReason: 'cancelled' };
    },
  });
  const { run, ac } = w.turn('go', { approve: () => new Promise(() => {}) });
  await sleep(30);
  ac.abort();
  await assert.rejects(run, (e) => e.name === 'AbortError');
  assert.deepEqual(store.answer.result, { outcome: { outcome: 'cancelled' } });
  await w.sessions.releaseAll();
});

test('follow-up: the running prompt is cancelled softly, keeps its output, and the message stays queued', async () => {
  const w = world({ onPrompt: hangingPrompt(['working…']) });
  let wake;
  const queue = [{ role: 'user', parts: [{ type: 'text', text: 'also do B' }] }];
  const taken = [];
  const followUp = {
    onWake: (cb) => ((wake = cb), () => {}),
    take: async () => (taken.push('take'), []),
    delivered: async () => {},
  };
  const { run, out } = w.turn('do A', { followUp });
  await sleep(30);
  followUp.take = async () => (taken.push('take'), queue);
  wake();
  const r = await run;
  assert.equal(r.interrupted, true);
  assert.equal(r.parts.at(-1).text, 'working…');
  assert.equal(out.text, 'working…');
  assert.equal(r.responseId, 's1');
  assert.equal(w.agents[0].calls('session/cancel').length, 1);
  assert.equal(queue.length, 1, 'the message was not consumed by the stopped turn');
  assert.equal(w.agents[0].stops, 0);
  await w.sessions.releaseAll();
});

test('process exit mid-turn: the turn fails with a clear message, the session is dropped, the next turn restarts', async () => {
  const w = world((n) =>
    n === 0
      ? {
          onPrompt: (p, a) => (
            a.text(p.sessionId, 'half'),
            setTimeout(() => ((a.err = `crash ${SECRET}`), a.exit(1)), 5),
            new Promise(() => {})
          ),
        }
      : {},
  );
  await assert.rejects(w.turn('x').run, (e) => {
    assert.match(e.message, /agent process ended \(exit 1\)/);
    assert.ok(!e.message.includes(SECRET), 'secrets are scrubbed from errors');
    return true;
  });
  await w.turn('y').run;
  assert.equal(w.agents.length, 2);
  await w.sessions.releaseAll();
});

test('refusal and token-limit stop reasons', async () => {
  let w = world({ onPrompt: () => ({ stopReason: 'refusal' }) });
  await assert.rejects(w.turn('x').run, (e) => e.code === 'refused');
  await w.sessions.releaseAll();
  w = world({ onPrompt: (p, a) => (a.text(p.sessionId, 'cut'), { stopReason: 'max_tokens' }) });
  const { run, out } = w.turn('x');
  await run;
  assert.match(out.text, /^cut\n\n\[Antigravity stopped: token limit reached\.\]$/);
  await w.sessions.releaseAll();
});

test('images are sent as ACP image blocks only when the agent accepts them', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(S.promptBlocks('t', [png], true), [
    { type: 'text', text: 't' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
  ]);
  const none = S.promptBlocks('t', [png, 'data:text/html;base64,PGI+'], false);
  assert.equal(none.length, 1);
  assert.match(none[0].text, /2 attached images were not sent/);
  assert.equal(S.promptBlocks('t', ['data:text/html;base64,PGI+'], true).length, 1); // not an image type
});

// ---- sign-in ---------------------------------------------------------------------------------------------------------

test('a non-interactive start never signs in: the sign-in link fails it with signin-required and stops the process', async () => {
  const w = world(
    { onRequest: (m) => (m.method === 'authenticate' ? 'silent' : undefined) },
    { onOpen: (a, args) => setTimeout(() => args.onAuthUrl(AUTH_URL), 5) },
  );
  await assert.rejects(
    w.turn('x').run,
    (e) => e.code === 'signin-required' && e.message === S.SIGN_IN_REQUIRED_MESSAGE,
  );
  assert.equal(w.agents[0].stops, 1);
  assert.equal(w.agents[0].calls('session/new').length, 0);
  assert.equal(w.agents[0].calls('session/prompt').length, 0);
});

test('an auth-required error from the agent is signin-required too; other auth errors are auth-failed and scrubbed', async () => {
  let w = world({
    onRequest: (m, r) =>
      m.method === 'authenticate' ? (r.fail(-32000, 'Authentication required'), 'handled') : undefined,
  });
  await assert.rejects(w.turn('x').run, (e) => e.code === 'signin-required');
  w = world(
    {
      onRequest: (m, r) => (m.method === 'authenticate' ? (r.fail(-32602, `bad key ${SECRET}`), 'handled') : undefined),
    },
    { method: 'gemini-api-key' },
  );
  await assert.rejects(
    w.turn('x').run,
    (e) => e.code === 'auth-failed' && !e.message.includes(SECRET) && /\*\*\*/.test(e.message),
  );
});

test('explicit sign-in: the validated link reaches onUrl, authenticate completes after the browser, models are returned', async () => {
  let done;
  const urls = [];
  const w = world(
    {
      onRequest: (m, r) =>
        m.method === 'authenticate'
          ? (new Promise((res) => (done = res)).then(() => r.reply({})), 'handled')
          : undefined,
    },
    { onOpen: (a, args) => setTimeout(() => (args.onAuthUrl(AUTH_URL), args.onAuthUrl(AUTH_URL)), 5) },
  );
  const p = S.signInAgent(w.deps, '/tmp/agy', 'agy-1', { onUrl: (u) => urls.push(u), timeoutMs: 5000 });
  await sleep(40);
  assert.deepEqual(urls, [AUTH_URL], 'one distinct link, reported once');
  done();
  const info = await p;
  assert.deepEqual(
    info.models.map((m) => m.id),
    ['default', 'agy-fast', 'agy-pro'],
  );
  assert.deepEqual(info.levels, { low: 'low', high: 'high' });
  assert.equal(info.version, '1.3.0');
  assert.equal(w.agents[0].stops, 1, 'the sign-in process is stopped afterwards');
});

test('explicit sign-in: cancel aborts and stops the process; the timeout fails it; denial is explained', async () => {
  const silent = { onRequest: (m) => (m.method === 'authenticate' ? 'silent' : undefined) };
  let w = world(silent);
  const ac = new AbortController();
  const p = S.signInAgent(w.deps, '/t', 'p', { onUrl() {}, signal: ac.signal });
  await sleep(30);
  ac.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.equal(w.agents[0].stops, 1);
  w = world(silent);
  await assert.rejects(
    S.signInAgent(w.deps, '/t', 'p', { onUrl() {}, timeoutMs: 40 }),
    (e) => e.code === 'auth-failed' && /timed out/.test(e.message),
  );
  assert.equal(w.agents[0].stops, 1);
  w = world({
    onRequest: (m, r) =>
      m.method === 'authenticate' ? (r.fail(-32603, 'access_denied by user'), 'handled') : undefined,
  });
  await assert.rejects(S.signInAgent(w.deps, '/t', 'p', { onUrl() {} }), (e) => /not approved/.test(e.message));
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(
    S.signInAgent(w.deps, '/t', 'p', { onUrl() {}, signal: pre.signal }),
    (e) => e.name === 'AbortError',
  );
});

test('API-key sign-in needs no link and works with the key in the agent environment only', async () => {
  const w = world({}, { method: 'gemini-api-key' });
  const info = await S.signInAgent(w.deps, '/t', 'p', { onUrl: () => assert.fail('no link expected') });
  assert.equal(info.models.length, 3);
  assert.deepEqual(w.agents[0].calls('authenticate')[0].params, { methodId: 'gemini-api-key' });
  assert.ok(!JSON.stringify(w.agents[0].written).includes(SECRET), 'the key is never sent over the protocol');
});

test('the health probe runs initialize only', async () => {
  const w = world();
  const probe = await S.probeAgent(w.deps, '/t');
  assert.deepEqual(w.agents[0].methods(), ['initialize']);
  assert.equal(probe.version, '1.3.0');
  assert.deepEqual(probe.methods, ['oauth-personal']);
  assert.equal(w.agents[0].stops, 1);
});

test('a missing executable is reported as not installed (spawn error and shell exit 127)', async () => {
  const enoent = Object.assign(new Error('program not found: agy_acp_server'), { code: 'ENOENT' });
  await assert.rejects(S.probeAgent(world({}, { openError: enoent }).deps, '/t'), (e) => e.code === 'not-installed');
  const dead = world(
    { onRequest: () => 'silent' },
    { onOpen: (a) => ((a.err = 'agy_acp_server not found'), setTimeout(() => a.exit(127), 5)) },
  );
  await assert.rejects(
    S.probeAgent(dead.deps, '/t'),
    (e) => e.code === 'not-installed' && e.message === S.NOT_INSTALLED_MESSAGE,
  );
});

test('sign out uses the agent logout request when it has one', async () => {
  let w = world({
    initialize: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } }, authMethods: [] },
    onRequest: (m, r) => (m.method === 'logout' ? (r.reply({}), 'handled') : undefined),
  });
  assert.equal(await S.signOutAgent(w.deps, '/t'), true);
  assert.deepEqual(w.agents[0].methods(), ['initialize', 'logout']);
  w = world();
  assert.equal(await S.signOutAgent(w.deps, '/t'), false);
  assert.deepEqual(w.agents[0].methods(), ['initialize']);
});

test('decide / answerFor policy table', async () => {
  const req = (kinds, id = 't') => ({
    sessionId: 's',
    toolCallId: id,
    title: 'T',
    options: kinds.map((k) => ({ optionId: k, name: k, kind: k })),
    detail: '',
  });
  const ok = { access: 'auto', mode: 'agent', approve: async () => true };
  assert.equal(await S.decide(req(['allow_once', 'reject_once']), ok), 'allow');
  assert.equal(await S.decide(req(['allow_once', 'reject_once']), { ...ok, mode: 'plan' }), 'deny');
  assert.equal(await S.decide(req(['allow_once', 'reject_once']), { ...ok, mode: 'ask', access: 'full' }), 'deny');
  assert.equal(await S.decide(req(['a', 'b']), ok), 'cancel');
  assert.deepEqual(S.answerFor(req(['allow_once']), 'deny'), { outcome: 'cancelled' });
  assert.deepEqual(S.answerFor(req(['reject_always', 'reject_once']), 'deny'), {
    outcome: 'selected',
    optionId: 'reject_once',
  });
});
