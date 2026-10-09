// The `gustaf-agent` command (src/agent/agentCli.ts, agentTargets.ts, agentBridge.ts): argv parsing, the `list` output, and
// spawn / wait / stop / delegate flows through the REAL SubagentHost with fake API and CLI adapters (no process, git or
// network). The launcher and the bridge server are tested in agentLauncher.test.mjs and the Rust module.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state, review } = await import('./helpers/apiStub.mjs');
const { createSubagentHost } = await import('../src/agent/subagents.ts');
const { Scheduler } = await import('../src/agent/scheduler.ts');
const { getRuns, resetAgentRuns } = await import('../src/agent/agentRuns.ts');
const { normalizeAgentSettings } = await import('../src/agent/agentSettings.ts');
const { createAgentBridge } = await import('../src/agent/agentBridge.ts');
const { createTokenRegistry } = await import('../src/agent/bridgeTokens.ts');
const cli = await import('../src/agent/agentCli.ts');
const targets = await import('../src/agent/agentTargets.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');

before(() => saveRulesConfig(DEFAULT_RULES));

// ---- argv ----

const ok = (input, ...argv) => {
  const r = cli.parseAgentArgv(argv, input);
  assert.equal(r.ok, true, `${argv.join(' ')}: ${r.error}`);
  return r.call;
};
const bad = (re, ...argv) => {
  const r = cli.parseAgentArgv(argv);
  assert.equal(r.ok, false, argv.join(' '));
  assert.match(r.error, re);
};

test('spawn: options, defaults and the task text', () => {
  const c = ok(
    undefined,
    'spawn',
    '--provider',
    'cursor',
    '--model=Composer 2',
    '--type',
    'general',
    '--background',
    'run',
    'ls',
  );
  assert.deepEqual(c, {
    op: 'spawn',
    background: true,
    args: { title: 'run ls', prompt: 'run ls', type: 'general', files: [], provider: 'cursor', model: 'Composer 2' },
  });
  const d = ok(undefined, 'spawn', '--title', 'Look', '--files', 'a.ts, b/c.ts', 'read it');
  assert.equal(d.args.type, 'explore');
  assert.deepEqual(d.args.files, ['a.ts', 'b/c.ts']);
  assert.equal(d.args.title, 'Look');
  assert.equal(d.background, false);
  assert.equal(ok('long task\nfrom stdin', 'spawn', '-').args.prompt, 'long task\nfrom stdin');
  assert.equal(ok(undefined, 'spawn', '--', '--not-a-flag').args.prompt, '--not-a-flag');
});

test('spawn: refusals name the problem', () => {
  bad(/needs the task text/, 'spawn');
  bad(/needs the task text/, 'spawn', '-');
  bad(/--type must be one of/, 'spawn', '--type', 'wizard', 'x');
  bad(/--role must be one of/, 'spawn', '--role', 'boss', 'x');
  bad(/either --role or --provider/, 'spawn', '--role', 'tester', '--model', 'm', 'x');
  bad(/Unknown option --bogus/, 'spawn', '--bogus', 'x');
  bad(/--provider needs a value/, 'spawn', '--provider');
  bad(/too long/, 'spawn', 'x'.repeat(20_001));
  bad(/does not apply to list/, 'list', '--type', 'general');
  bad(/Unknown command "spwan"/, 'spwan', 'x');
  bad(/No command/);
});

test('wait, status, report, stop, list and delegate', () => {
  assert.deepEqual(ok(undefined, 'wait', 't1', 't2', 't1'), { op: 'wait', ids: ['t1', 't2'], timeoutS: 45 });
  assert.equal(ok(undefined, 'wait', 't1', '--timeout', '600').timeoutS, 50, 'a call never blocks longer than the cap');
  assert.equal(ok(undefined, 'wait', 't1', '--timeout=10').timeoutS, 10);
  bad(/at least one task id/, 'wait');
  bad(/not a task id/, 'wait', 'x y');
  bad(/--timeout must be/, 'wait', 't1', '--timeout', 'soon');
  assert.deepEqual(ok(undefined, 'status'), { op: 'status' });
  assert.deepEqual(ok(undefined, 'status', 't3'), { op: 'status', id: 't3' });
  assert.deepEqual(ok(undefined, 'report', 't3'), { op: 'report', id: 't3' });
  assert.deepEqual(ok(undefined, 'stop', 't3'), { op: 'stop', id: 't3' });
  bad(/exactly one task id/, 'stop');
  assert.deepEqual(ok(undefined, 'list', 'composer', '2'), { op: 'list', filter: 'composer 2' });
  assert.deepEqual(ok('{"tasks":[]}', 'delegate', 'plan.json'), { op: 'delegate', plan: { tasks: [] } });
  bad(/needs a plan/, 'delegate', 'missing.json');
  const r = cli.parseAgentArgv(['delegate', '-'], '{nope');
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON/);
});

test('the usage and the prompt name the commands and the loop', () => {
  for (const w of ['list', 'spawn', 'delegate', 'wait', 'status', 'report', 'stop'])
    assert.match(cli.AGENT_CLI_USAGE, new RegExp(`\\n  ${w} `));
  assert.match(cli.AGENT_CLI_PROMPT, /instead of your native Task or subagent tool/);
  assert.match(cli.AGENT_CLI_PROMPT, /do not end your turn/);
  assert.match(cli.AGENT_CLI_PROMPT, /first and use the ids it prints \(never guess/);
  assert.match(cli.AGENT_CLI_PROMPT, /untrusted data/);
});

// ---- targets ----

const known = [
  { id: 'opus', name: 'Claude Code', cli: true, models: [{ id: 'haiku', name: 'Haiku' }] },
  {
    id: 'cursor1',
    name: 'Cursor',
    cli: true,
    models: [
      { id: 'composer-2', name: 'Composer 2' },
      { id: 'auto', name: 'Auto' },
    ],
  },
  { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-6.1', name: 'GPT 6.1' }] },
  { id: 'gem', name: 'Gemini', models: [{ id: 'gemini-3', name: 'Gemini 3' }] },
  { id: 'ag', name: 'Antigravity', cli: true, unusable: 'Antigravity asks for approvals interactively.', models: [] },
];
const settingsFor = (allowed, extra = {}) => normalizeAgentSettings({ allowedProviders: allowed, ...extra });
const tgt = (allowed = ['cursor1', 'openai', 'ag']) =>
  targets.buildTargets(settingsFor(allowed), { providerId: 'opus', model: 'haiku' }, known, 3);

test('list shows ids, display names, kind and whether each provider is usable now', () => {
  const text = targets.renderTargets(tgt());
  assert.match(text, /^cursor1 {2}"Cursor" {2}\[CLI agent; usable\]$/m);
  assert.match(text, /^ {4}composer-2 {2}"Composer 2" \(Cursor\)$/m);
  assert.match(text, /^openai {2}"OpenAI" {2}\[API; usable\]$/m);
  assert.match(text, /^ag {2}"Antigravity" {2}\[CLI agent; Antigravity asks for approvals/m);
  assert.match(
    text,
    /^gem {2}"Gemini" {2}\[API; not allowed: add it under Settings > Usage > Agents > Providers agents may request\]$/m,
  );
  assert.match(text, /^opus {2}"Claude Code" {2}\[CLI agent; usable\]$/m, "the chat's own provider is always allowed");
  assert.match(text, /At most 3 subagents run at the same time/);
});

test('list <text> narrows providers and models', () => {
  const text = targets.renderTargets(tgt(), 'composer');
  assert.match(text, /composer-2/);
  assert.doesNotMatch(text, /gpt-6\.1/);
  assert.doesNotMatch(text, /"Auto"/);
  assert.match(targets.renderTargets(tgt(), 'nothing-like-this'), /Nothing matches/);
});

test('roles are listed with their state', () => {
  const t = targets.buildTargets(
    settingsFor(['cursor1'], {
      roles: {
        implementer: { providerId: 'cursor1', model: 'composer-2' },
        tester: { providerId: 'gem', model: 'gemini-3' },
      },
    }),
    { providerId: 'opus', model: 'haiku' },
    known,
    3,
  );
  const text = targets.renderTargets(t);
  assert.match(text, /implementer -> cursor1\/composer-2$/m);
  assert.match(text, /tester -> gem\/gemini-3 \(not usable now\)$/m);
});

test('names resolve to ids: a model name alone, provider/model, a provider name', () => {
  const t = tgt();
  assert.deepEqual(targets.resolveTarget({ model: 'Composer 2' }, t), {
    ok: true,
    provider: 'cursor1',
    model: 'composer-2',
  });
  assert.deepEqual(targets.resolveTarget({ model: 'cursor1/auto' }, t), {
    ok: true,
    provider: 'cursor1',
    model: 'auto',
  });
  assert.deepEqual(targets.resolveTarget({ model: 'gpt' }, t), { ok: true, provider: 'openai', model: 'gpt-6.1' });
  assert.deepEqual(targets.resolveTarget({ provider: 'Cursor', model: 'composer 2' }, t), {
    ok: true,
    provider: 'cursor1',
    model: 'composer-2',
  });
  assert.deepEqual(targets.resolveTarget({ provider: 'openai' }, t), { ok: true, provider: 'openai' });
  assert.deepEqual(targets.resolveTarget({ role: 'tester' }, t), { ok: true });
  assert.deepEqual(targets.resolveTarget({}, t), { ok: true });
  const none = targets.resolveTarget({ model: 'gemini' }, t);
  assert.equal(none.ok, false, 'a provider that is not allowed is not searched');
  assert.match(none.error, /No usable provider has a model "gemini"/);
  const many = targets.resolveTarget({ model: 'o' }, tgt(['cursor1', 'openai']));
  assert.equal(many.ok, false);
  assert.match(many.error, /matches several/);
});

// ---- flows through the real host ----

const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
const act = (id, name, args, status = 'running', output) => ({
  type: 'activity',
  id,
  name,
  args,
  status,
  ...(output ? { output } : {}),
});

/** Polls until `cond` holds (real time, a few ms). */
const until_ = async (cond) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

/** A gate a test opens to let a fake agent finish. */
const gate = () => {
  let open;
  const promise = new Promise((r) => (open = r));
  return { promise, open };
};

/**
 * Fake adapters: `script(input)` runs the task. A CLI adapter reports activity and text; a hanging one ends only when its
 * gate opens or its signal aborts (a killed process).
 */
function fakeAdapter(name, script, calls) {
  return {
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      calls.push({ name, input });
      return script(input);
    },
  };
}
const answer = (text) => async (input) => {
  input.onActivity?.(act('a', 'Bash', { command: 'ls' }));
  input.onActivity?.(act('a', 'Bash', { command: 'ls' }, 'success', 'x'));
  input.onText(text);
  return { parts: [{ type: 'text', text }], usage };
};
const until =
  (g, text, seen = {}) =>
  (input) =>
    new Promise((resolve, reject) => {
      input.onActivity?.(act('s', 'Bash', { command: 'sleep 30' }));
      input.signal.addEventListener('abort', () => {
        seen.killed = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
      void g.promise.then(() => {
        input.onText(text);
        resolve({ parts: [{ type: 'text', text }], usage });
      });
    });

function setup({ scripts = {}, settings = {}, parentAccess = 'auto', enabled = true } = {}) {
  state.reset();
  resetAgentRuns();
  const calls = [];
  const created = [];
  const root = mkdtempSync(join(tmpdir(), 'agent-bridge-'));
  const directory = {
    list: () => known,
    resolve: async (id, model) => {
      const p = known.find((k) => k.id === id);
      if (p.unusable) return { ok: false, reason: p.unusable };
      const adapter = fakeAdapter(id, scripts[id] ?? answer(`${id} done`), calls);
      return p.cli
        ? { ok: true, kind: 'cli', adapter, cli: 'codex', model: model ?? 'default', name: p.name }
        : { ok: true, kind: 'api', adapter, supportsTools: true, model: model ?? p.models[0].id, name: p.name };
    },
  };
  const host = createSubagentHost({
    projectRoot: root,
    recordTokens: () => {},
    settings: normalizeAgentSettings({
      allowedProviders: ['cursor1', 'openai', 'ag'],
      cliSubagents: enabled,
      ...settings,
    }),
    providers: directory,
    worktrees: {
      create: async (a) => {
        created.push(a);
        const n = created.length;
        return { taskId: `w${n}`, branch: `gustaf/w${n}`, cwd: `/wt/w${n}`, path: `/wt/w${n}`, baseCommit: 'abc' };
      },
      inspect: async () => ({ files: [], touched: false }),
      remove: async () => true,
    },
    scheduler: new Scheduler(3),
    retryBackoffMs: () => 0,
    checkBudget: async () => null,
    prepare: async (r) => ({ review: { id: 'r1', root: r, workspace: '/shadow', linked: [] }, setup: null }),
  });
  review.list = async () => [];
  review.finish = async () => {};
  const ctl = new AbortController();
  const parent = {
    root,
    providerId: 'opus',
    model: 'haiku',
    access: parentAccess,
    allowlist: [],
    signal: ctl.signal,
    approve: async () => true,
    adapter: null,
    chatId: 7,
    supportsTools: true,
  };
  const tokens = createTokenRegistry(() => 'f'.repeat(64));
  const audit = [];
  const bridge = createAgentBridge({
    tokens,
    // Time runs a thousand times faster: a 45 s wait takes 45 ms.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms / 1000)),
    audit: (tool, summary) => {
      const e = { tool, summary };
      audit.push(e);
      return (status, detail) => Object.assign(e, { status, detail });
    },
  });
  const token = bridge.tokenFor(7);
  const end = bridge.beginTurn(7, { signal: ctl.signal, host, parent });
  const call = (...argv) => bridge.handle({ id: 1, token, argv });
  return { bridge, call, end, ctl, calls, created, audit, token, parent, host };
}

test('spawn --background returns an id at once; wait reports progress until the report is there', async () => {
  const g = gate();
  const { call } = setup({ scripts: { cursor1: until(g, 'ls shows 3 files') } });
  const started = await call(
    'spawn',
    '--provider',
    'cursor1',
    '--model',
    'Composer 2',
    '--background',
    'run ls and wait 30 seconds',
  );
  assert.equal(started.ok, true);
  assert.match(
    started.text,
    /^Started task t1 "run ls and wait 30 seconds" on cursor1\/composer-2; it shows in the Agents panel\./,
  );
  assert.match(started.text, /gustaf-agent wait t1/);

  // The long poll spans several calls; each says what the task is doing.
  for (let i = 0; i < 3; i++) {
    const w = await call('wait', 't1', '--timeout', '2');
    assert.equal(w.ok, true);
    assert.match(w.text, /Task t1 .*\(cursor1\/composer-2\): running - running, .*1 tool uses, now: Bash .*sleep 30/);
    assert.match(w.text, /Not finished: t1\. Call `gustaf-agent wait t1` again\./);
  }
  const status = await call('status');
  assert.match(status.text, /Task t1 .*: running/);

  g.open();
  const done = await call('wait', 't1');
  assert.match(done.text, /Task t1 .*: finished after/);
  assert.match(done.text, /Subagent "run ls and wait 30 seconds" \(explore, via Cursor\) finished\./);
  assert.match(done.text, /ls shows 3 files/);
  assert.doesNotMatch(done.text, /Not finished/);
  assert.match((await call('report', 't1')).text, /ls shows 3 files/);
});

test('the task shows up in the Agents panel store like any subagent run, with the chat id', async () => {
  const g = gate();
  const { call, calls } = setup({ scripts: { cursor1: until(g, 'ok') } });
  await call('spawn', '--provider', 'cursor1', '--background', '--title', 'Check', 'look');
  const runs = getRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].title, 'Check');
  assert.equal(runs[0].chatId, 7);
  assert.equal(runs[0].providerId, 'cursor1');
  assert.ok(['queued', 'running'].includes(runs[0].status));
  g.open();
  await call('wait', 't1');
  assert.equal(getRuns()[0].status, 'completed');
  assert.equal(calls[0].input.access, 'readonly', 'explore is read-only');
});

test('spawn without --background waits for a quick task and prints its report', async () => {
  const { call } = setup({ scripts: { openai: answer('GPT says hi') } });
  const r = await call('spawn', '--model', 'gpt-6.1', 'say hi');
  assert.equal(r.ok, true);
  assert.match(r.text, /Started task t1 .* on openai\/gpt-6\.1/);
  assert.match(r.text, /Task t1 .*: finished after/);
  assert.match(r.text, /GPT says hi/);
});

test("without a target the subagent runs on the chat's own provider", async () => {
  const { call, calls } = setup({ scripts: { opus: answer('own') } });
  const r = await call('spawn', '--background', 'x');
  assert.match(r.text, /on opus\/default/);
  await call('wait', 't1');
  assert.equal(calls[0].name, 'opus');
});

test('three tasks on three providers run in parallel and wait collects all reports', async () => {
  const gc = gate();
  const gh = gate();
  const gg = gate();
  const { call, calls } = setup({
    scripts: {
      cursor1: until(gc, 'composer report'),
      opus: until(gh, 'haiku report'),
      openai: until(gg, 'gpt report'),
    },
  });
  const a = await call('spawn', '--model', 'Composer 2', '--type', 'general', '--background', 'ls then wait 30 s');
  const b = await call(
    'spawn',
    '--provider',
    'opus',
    '--model',
    'haiku',
    '--type',
    'general',
    '--background',
    'ls then wait 30 s',
  );
  const c = await call('spawn', '--model', 'GPT 6.1', '--type', 'general', '--background', 'ls then wait 30 s');
  assert.deepEqual(
    [a, b, c].map((r) => /task (t\d)/.exec(r.text)[1]),
    ['t1', 't2', 't3'],
  );
  await until_(() => calls.length === 3); // the API subagent loop loads its context first
  assert.equal(calls.length, 3, 'all three started before any finished');
  assert.deepEqual(calls.map((c) => c.name).sort(), ['cursor1', 'openai', 'opus']);
  const w = await call('wait', 't1', 't2', 't3', '--timeout', '1');
  assert.match(w.text, /Not finished: t1, t2, t3\./);
  gh.open();
  const partial = await call('wait', 't1', 't2', 't3', '--timeout', '1');
  assert.match(partial.text, /Task t2 .*: finished/);
  assert.match(partial.text, /haiku report/);
  assert.match(partial.text, /Not finished: t1, t3\./);
  gc.open();
  gg.open();
  const all = await call('wait', 't1', 't2', 't3');
  assert.match(all.text, /composer report[\s\S]*haiku report[\s\S]*gpt report/);
  assert.match(all.text, /All 3 finished\./);
  assert.deepEqual(
    getRuns()
      .filter((r) => r.title === 'ls then wait 30 s')
      .map((r) => r.providerId)
      .sort(),
    ['cursor1', 'openai', 'opus'],
  );
  assert.ok(
    getRuns()
      .filter((r) => r.title === 'ls then wait 30 s')
      .every((r) => r.status === 'completed'),
  );
});

test('stop kills the task and reports it cancelled', async () => {
  const seen = {};
  const { call } = setup({ scripts: { cursor1: until(gate(), 'never', seen) } });
  await call('spawn', '--provider', 'cursor1', '--background', 'long');
  const r = await call('stop', 't1');
  assert.equal(r.ok, true);
  assert.equal(seen.killed, true);
  assert.match(r.text, /^Stopped\./);
  assert.match(r.text, /was cancelled/);
  assert.equal(getRuns()[0].status, 'cancelled');
  assert.match((await call('stop', 't1')).text, /had already finished/);
});

test('stopping the main run, or ending its turn, stops the tasks', async () => {
  const a = {};
  const s1 = setup({ scripts: { cursor1: until(gate(), 'never', a) } });
  await s1.call('spawn', '--provider', 'cursor1', '--background', 'long');
  s1.ctl.abort();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(a.killed, true);
  assert.equal(getRuns()[0].status, 'cancelled');

  const b = {};
  const s2 = setup({ scripts: { cursor1: until(gate(), 'never', b) } });
  await s2.call('spawn', '--provider', 'cursor1', '--background', 'long');
  s2.end();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(b.killed, true, 'a task does not outlive the agent turn that started it');
  const after = await s2.call('status');
  assert.match(after.text, /no agent run is active/);
});

test('delegate runs a plan through the same host: providers by name, dependencies, one merged summary', async () => {
  const s = setup({ scripts: { cursor1: answer('composer part'), openai: answer('gpt part') } });
  const plan = {
    tasks: [
      { id: 'a', title: 'First', prompt: 'do a', type: 'explore', model: 'Composer 2' },
      { id: 'b', title: 'Second', prompt: 'do b', type: 'explore', provider: 'OpenAI', dependsOn: ['a'] },
    ],
  };
  const withPlan = (input) => s.bridge.handle({ id: 1, token: s.token, argv: ['delegate', '-'], input });
  const none = await withPlan(undefined);
  assert.equal(none.ok, false);
  assert.match(none.text, /needs a plan/);
  const started = await withPlan(JSON.stringify(plan));
  assert.equal(started.ok, true, started.text);
  assert.match(started.text, /Started plan p1 with 2 tasks/);
  const done = await s.call('wait', 'p1');
  assert.match(done.text, /composer part/);
  assert.match(done.text, /gpt part/);
  assert.deepEqual(
    s.calls.map((c) => c.name),
    ['cursor1', 'openai'],
  );
  const second = s.calls[1].input.messages[0].parts[0].text;
  assert.match(second, /composer part/, 'the dependant receives the report it depends on');
});

test('a plan naming a provider that is not allowed is refused as a whole', async () => {
  const s = setup();
  const plan = { tasks: [{ id: 'a', title: 'A', prompt: 'x', type: 'explore', provider: 'gem' }] };
  const r = await s.bridge.handle({ id: 1, token: s.token, argv: ['delegate', '-'], input: JSON.stringify(plan) });
  assert.equal(r.ok, false);
  assert.match(r.text, /Task "a": Provider "gem" is not allowed for subagents/);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(getRuns(), []);
});

test('providers that are not allowed or cannot run are refused with the reason, and nothing starts', async () => {
  const s = setup();
  const notAllowed = await s.call('spawn', '--provider', 'gem', 'x');
  assert.equal(notAllowed.ok, false);
  assert.match(notAllowed.text, /Run `gustaf-agent list` to see the providers and models you may request\./);
  assert.match(notAllowed.text, /not allowed for subagents \(Settings > Usage > Agents > Allowed providers\)/);
  const unusable = await s.call('spawn', '--provider', 'ag', 'x');
  assert.equal(unusable.ok, false);
  assert.match(unusable.text, /cannot run this subagent: Antigravity asks for approvals/);
  const unknownModel = await s.call('spawn', '--model', 'no-such-model', 'x');
  assert.equal(unknownModel.ok, false);
  assert.match(unknownModel.text, /No usable provider has a model/);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(getRuns(), []);
  assert.equal((await s.call('status')).text, 'No subagents were started in this chat.');
});

test("the main agent's access caps what a subagent may do", async () => {
  const auto = setup({ scripts: { cursor1: answer('w') } });
  await auto.call('spawn', '--provider', 'cursor1', '--type', 'general', 'edit');
  assert.equal(auto.calls[0].input.access, 'auto');
  assert.equal(auto.created.length, 1, 'a writing CLI subagent gets its own worktree');
  const full = setup({ parentAccess: 'full', scripts: { cursor1: answer('w') } });
  await full.call('spawn', '--provider', 'cursor1', '--type', 'general', 'edit');
  assert.equal(full.calls[0].input.access, 'auto', 'never more than auto, even for a full-access main agent');
  const ro = setup({ parentAccess: 'readonly', scripts: { cursor1: answer('w') } });
  await ro.call('spawn', '--provider', 'cursor1', '--type', 'general', 'edit');
  assert.equal(ro.calls[0].input.access, 'readonly', 'a read-only main agent cannot start a writing subagent');
});

test('a subagent has no bridge environment, so it cannot start subagents itself', async () => {
  const s = setup({ scripts: { cursor1: answer('w') } });
  await s.call('spawn', '--provider', 'cursor1', 'x');
  assert.equal(s.calls[0].input.device, undefined);
  assert.deepEqual(s.calls[0].input.tools, []);
});

test('requests are refused for unknown tokens, without an active run, and when the setting is off', async () => {
  const s = setup();
  assert.match((await s.bridge.handle({ id: 1, token: 'nope', argv: ['list'] })).text, /unknown session/);
  const off = setup({ enabled: false });
  const r = await off.call('list');
  assert.equal(r.ok, false);
  assert.match(r.text, /subagents from CLI agents are off/);
  s.end();
  assert.match((await s.call('list')).text, /no agent run is active/);
  const stopped = setup();
  stopped.ctl.abort();
  assert.match((await stopped.call('list')).text, /no agent run is active/);
});

test('a parse error prints the reason and the usage; list needs no task', async () => {
  const s = setup();
  const r = await s.call('spwan', 'x');
  assert.equal(r.ok, false);
  assert.match(r.text, /^gustaf-agent: Unknown command "spwan"\.\n\nUsage: gustaf-agent/);
  const list = await s.call('list', 'composer');
  assert.equal(list.ok, true);
  assert.match(list.text, /composer-2/);
});

test('start and stop are recorded in the action log; waiting is not', async () => {
  const s = setup({ scripts: { cursor1: until(gate(), 'x') } });
  await s.call('spawn', '--provider', 'cursor1', '--background', 'job');
  await s.call('wait', 't1', '--timeout', '1');
  await s.call('stop', 't1');
  assert.deepEqual(
    s.audit.map((e) => [e.tool, e.status]),
    [
      ['gustaf-agent spawn', 'success'],
      ['gustaf-agent stop', 'success'],
    ],
  );
});

test('too many unfinished tasks are refused', async () => {
  const s = setup({ scripts: { cursor1: until(gate(), 'x') } });
  for (let i = 0; i < 12; i++)
    assert.equal((await s.call('spawn', '--provider', 'cursor1', '--background', `job ${i}`)).ok, true);
  const r = await s.call('spawn', '--provider', 'cursor1', '--background', 'one more');
  assert.equal(r.ok, false);
  assert.match(r.text, /Too many unfinished subagents/);
  s.end();
});

// ---- settings and the provider directory ----

test('the CLI-subagents setting defaults on and survives normalization', () => {
  assert.equal(normalizeAgentSettings(undefined).cliSubagents, true);
  assert.equal(normalizeAgentSettings({ cliSubagents: false }).cliSubagents, false);
  assert.equal(normalizeAgentSettings({ cliSubagents: 'no' }).cliSubagents, true);
});
