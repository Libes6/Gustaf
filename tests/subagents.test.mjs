// Subagent runtime on top of the real agent loop: scripted models, a real temporary project, fake shadow copies made by
// plain directory copies (the real ones are Rust, src-tauri/src/review.rs). Nothing here runs a command for real.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state, review } = await import('./helpers/apiStub.mjs');
const { runAgent } = await import('../src/agent/agent.ts');
const { createSubagentHost } = await import('../src/agent/subagents.ts');
const { Scheduler } = await import('../src/agent/scheduler.ts');
const { getRuns, resetAgentRuns, stopRun } = await import('../src/agent/agentRuns.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES, normalizeRulesConfig } = await import('../src/agent/rules.ts');

let n = 0;
const call = (name, args) => ({ type: 'tool_call', id: `c${n++}`, name, args });
const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
const say = (text) => ({ parts: [{ type: 'text', text }], usage });
const use = (...calls) => ({ parts: calls, usage });
const spawn = (title, prompt, type = 'explore') => call('spawn_agent', { title, prompt, type });

before(() => saveRulesConfig(DEFAULT_RULES));

function project(files = { 'a.txt': 'one\n', 'b.txt': 'two\n' }) {
  const root = mkdtempSync(join(tmpdir(), 'sub-test-'));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
  return root;
}

/** Shadow copies as flat directory copies; `review.list` reports files that differ from the project. */
function fakeReviews(root) {
  const made = [];
  const finished = [];
  const prepare = async (projectRoot) => {
    const id = `r${made.length + 1}`;
    const workspace = mkdtempSync(join(tmpdir(), 'sub-ws-'));
    for (const f of readdirSync(projectRoot)) copyFileSync(join(projectRoot, f), join(workspace, f));
    const r = { id, root: projectRoot, workspace };
    made.push(r);
    return { review: r, setup: null };
  };
  review.list = async () =>
    made
      .map((r) => [r, readdirSync(r.workspace).filter((f) => !existsSync(join(root, f)) || readFileSync(join(root, f), 'utf8') !== readFileSync(join(r.workspace, f), 'utf8')).map((path) => ({ path, binary: false }))])
      .filter(([, list]) => list.length);
  review.finish = async (id) => void finished.push(id);
  return { made, finished, prepare };
}

/**
 * Runs the main agent over `parentScript`; children are answered by `child(title-prompt text, input)`, a function that
 * returns the next scripted turn for that child (per-prompt queues keep parallel children independent).
 */
async function run({ root, parentScript, children = {}, hostCfg = {}, access = 'auto', approve, signal, parentTools = true } = {}) {
  state.reset();
  saveRulesConfig(hostCfg.rules ?? DEFAULT_RULES);
  resetAgentRuns();
  const ctl = new AbortController();
  if (signal) signal(ctl);
  const seen = { parentTools: [], childTools: {}, childSystems: {}, childMessages: {}, tokens: [], approvals: [], live: 0, maxLive: 0 };
  const queues = new Map(Object.entries(children).map(([k, v]) => [k, [...v]]));
  let pi = 0;
  const adapter = {
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      const isChild = input.system.includes('You are a subagent');
      if (!isChild) {
        seen.parentTools.push(input.tools.map((t) => t.name));
        return parentScript[pi++] ?? say('parent done');
      }
      const key = input.messages[0].parts[0].text;
      seen.childTools[key] = input.tools.map((t) => t.name);
      seen.childSystems[key] = input.system;
      seen.childMessages[key] = input.messages;
      seen.live++;
      seen.maxLive = Math.max(seen.maxLive, seen.live);
      try {
        await sleep(5);
        const q = queues.get(key) ?? [];
        const next = q.shift();
        if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return typeof next === 'function' ? await next(input) : next ?? say(`report for ${key}`);
      } finally {
        seen.live--;
      }
    },
  };
  const outputs = [];
  const host = createSubagentHost({ projectRoot: root, recordTokens: (p, m, u) => seen.tokens.push([p, m, u]), ...hostCfg });
  await runAgent({
    root,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'do the thing' }] }],
    adapter,
    providerId: 'p',
    model: 'm',
    access,
    computerUse: false,
    allowlist: [],
    signal: ctl.signal,
    onText: () => {},
    onMessage: async (m) => {
      if (m.role === 'tool') outputs.push(...m.parts.map((p) => ({ name: p.name, output: p.output, isError: !!p.isError })));
    },
    approve: async (req) => {
      seen.approvals.push(req);
      return approve ? approve(req) : true;
    },
    subagents: parentTools ? host : undefined,
  });
  return { outputs, seen, runs: getRuns() };
}

test('spawn_agent is offered only to the main loop with tools and write access', async () => {
  const root = project();
  const a = await run({ root, parentScript: [say('hi')] });
  assert.ok(a.seen.parentTools[0].includes('spawn_agent'));
  const b = await run({ root, parentScript: [say('hi')], access: 'readonly' });
  assert.ok(!b.seen.parentTools[0].includes('spawn_agent'));
  const c = await run({ root, parentScript: [say('hi')], parentTools: false });
  assert.ok(!c.seen.parentTools[0].includes('spawn_agent'));
});

test('a subagent has its own history, read-only tools, and only its report reaches the parent', async () => {
  const root = project();
  const r = await run({
    root,
    parentScript: [use(spawn('Explorer', 'find the answer')), say('ok')],
    children: { 'find the answer': [use(call('read_file', { path: 'a.txt' })), say('The answer is 42. ' + 'x'.repeat(20_000))] },
  });
  assert.deepEqual(r.seen.childTools['find the answer'], ['read_file', 'list_dir', 'search']);
  assert.equal(r.seen.childMessages['find the answer'][0].parts[0].text, 'find the answer');
  assert.match(r.seen.childSystems['find the answer'], /read-only/);
  assert.ok(!r.seen.childSystems['find the answer'].includes('do the thing'));
  const out = r.outputs.find((o) => o.name === 'spawn_agent');
  assert.match(out.output, /Subagent "Explorer" \(explore\) finished\./);
  assert.match(out.output, /The answer is 42/);
  assert.ok(out.output.length < 8_500, 'report is bounded');
  assert.match(out.output, /report truncated/);
  assert.ok(!out.output.includes('1|one'), 'tool results of the child do not leak to the parent');
  const run1 = r.runs[0];
  assert.equal(run1.status, 'completed');
  assert.equal(run1.toolUses, 1);
  assert.equal(run1.tokens, 30); // two turns of 15
  assert.equal(r.seen.tokens.length, 2); // the hook sees the child's two turns
  assert.ok(run1.transcript.some((s) => s.kind === 'tool' && s.tool === 'read_file'));
});

test('a read-only subagent cannot call a write tool even if the model tries', async () => {
  const root = project();
  const r = await run({
    root,
    parentScript: [use(spawn('Sneaky', 'try writing')), say('ok')],
    children: { 'try writing': [use(call('write_file', { path: 'evil.txt', content: 'x' })), say('done')] },
  });
  assert.equal(existsSync(join(root, 'evil.txt')), false);
  assert.equal(r.runs[0].transcript.find((s) => s.tool === 'write_file').error, true);
});

test('children cannot spawn children', async () => {
  const root = project();
  const r = await run({
    root,
    parentScript: [use(spawn('Outer', 'outer task', 'general')), say('ok')],
    hostCfg: { prepare: fakeReviews(root).prepare },
    children: { 'outer task': [use(spawn('Inner', 'inner task')), say('done')] },
  });
  assert.ok(!r.seen.childTools['outer task'].includes('spawn_agent'));
  assert.equal(r.runs.length, 1);
});

test('parallel subagents respect the concurrency limit and queue the rest', async () => {
  const root = project();
  const calls = [1, 2, 3, 4, 5].map((i) => spawn(`T${i}`, `task ${i}`));
  const r = await run({ root, parentScript: [use(...calls), say('ok')], hostCfg: { scheduler: new Scheduler(3) } });
  assert.equal(r.seen.maxLive, 3);
  assert.equal(r.outputs.filter((o) => o.name === 'spawn_agent' && /finished/.test(o.output)).length, 5);
  assert.deepEqual(r.runs.map((x) => x.status), Array(5).fill('completed'));
});

test('stopping the parent cancels running and queued subagents', async () => {
  const root = project();
  const calls = [1, 2, 3].map((i) => spawn(`T${i}`, `slow ${i}`));
  const slow = async (input) => {
    await sleep(200, undefined, { signal: input.signal }).catch(() => {});
    if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return say('late');
  };
  let ctl;
  const done = run({
    root,
    parentScript: [use(...calls), say('ok')],
    hostCfg: { scheduler: new Scheduler(1) },
    children: { 'slow 1': [slow], 'slow 2': [slow], 'slow 3': [slow] },
    signal: (c) => (ctl = c),
  });
  await sleep(40);
  ctl.abort();
  const r = await done;
  assert.deepEqual(r.runs.map((x) => x.status).sort(), ['cancelled', 'cancelled', 'cancelled']);
  assert.ok(r.runs.every((x) => x.endedAt));
});

test('stopRun cancels one run only', async () => {
  const root = project();
  const slow = async (input) => {
    await sleep(300, undefined, { signal: input.signal }).catch(() => {});
    if (input.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return say('finished anyway');
  };
  const done = run({ root, parentScript: [use(spawn('A', 'task a'), spawn('B', 'task b')), say('ok')], children: { 'task a': [slow], 'task b': [slow] } });
  await sleep(60);
  stopRun(getRuns().find((x) => x.title === 'A').id);
  const r = await done;
  assert.equal(r.runs.find((x) => x.title === 'A').status, 'cancelled');
  assert.equal(r.runs.find((x) => x.title === 'B').status, 'completed');
  assert.match(r.outputs.find((o) => /"A"/.test(o.output)).output, /was cancelled/);
});

test('budget: tool call limit stops the run and the report says so', async () => {
  const root = project();
  const looping = Array.from({ length: 10 }, () => use(call('list_dir', { path: '.' })));
  const r = await run({
    root,
    parentScript: [use(spawn('Looper', 'loop forever')), say('ok')],
    children: { 'loop forever': [{ parts: [{ type: 'text', text: 'looking around' }, call('list_dir', { path: '.' }), call('list_dir', { path: '.' }), call('list_dir', { path: '.' })], usage }, ...looping] },
    hostCfg: { budgets: { explore: { maxToolCalls: 2 } } },
  });
  const out = r.outputs.find((o) => o.name === 'spawn_agent').output;
  assert.match(out, /stopped at its tool call limit \(2\)/);
  assert.equal(r.runs[0].status, 'limit');
  assert.equal(r.runs[0].toolUses, 3);
  assert.match(r.outputs.find((o) => o.name === 'spawn_agent').output, /looking around/, 'the partial text is kept');
  assert.ok(r.runs[0].transcript.filter((s) => s.kind === 'tool').every((s) => s.error), 'calls past the limit were cancelled, not run');
});

test('budget: step limit ends a run that never answers', async () => {
  const root = project();
  const looping = Array.from({ length: 10 }, () => use(call('list_dir', { path: '.' })));
  const r = await run({
    root,
    parentScript: [use(spawn('Endless', 'never ends')), say('ok')],
    children: { 'never ends': looping },
    hostCfg: { budgets: { explore: { maxSteps: 3 } } },
  });
  assert.match(r.outputs.find((o) => o.name === 'spawn_agent').output, /step limit \(3\)/);
  assert.equal(r.runs[0].status, 'limit');
  assert.equal(r.runs[0].toolUses, 3);
});

test('budget: wall time stops a hanging run', async () => {
  const root = project();
  const hang = async (input) => {
    await sleep(2000, undefined, { signal: input.signal }).catch(() => {});
    throw new DOMException('Aborted', 'AbortError');
  };
  const r = await run({ root, parentScript: [use(spawn('Hang', 'hang')), say('ok')], children: { hang: [hang] }, hostCfg: { budgets: { explore: { maxMs: 60 } } } });
  assert.match(r.outputs.find((o) => o.name === 'spawn_agent').output, /time limit/);
  assert.equal(r.runs[0].status, 'limit');
});

test('a failing subagent reports the error and the parent continues', async () => {
  const root = project();
  const boom = async () => { throw new Error('HTTP 500'); };
  const r = await run({ root, parentScript: [use(spawn('Broken', 'break')), say('recovered')], children: { break: [boom] } });
  const out = r.outputs.find((o) => o.name === 'spawn_agent').output;
  assert.match(out, /failed: HTTP 500/);
  assert.equal(r.runs[0].status, 'failed');
  assert.equal(r.seen.parentTools.length, 2);
});

test('invalid spawn arguments come back as a tool error', async () => {
  const root = project();
  const r = await run({ root, parentScript: [use(call('spawn_agent', { title: 'x', prompt: 'y', type: 'root' })), say('ok')] });
  const out = r.outputs.find((o) => o.name === 'spawn_agent');
  assert.equal(out.isError, true);
  assert.match(out.output, /type/);
  assert.equal(r.runs.length, 0);
});

test('writing subagents work in separate copies; the project is untouched and overlapping files are flagged', async () => {
  const root = project();
  const fake = fakeReviews(root);
  const edit = (path, content) => use(call('write_file', { path, content }));
  const r = await run({
    root,
    parentScript: [use(spawn('Writer A', 'edit a', 'general')), use(spawn('Writer B', 'edit b', 'general')), say('ok')],
    hostCfg: { prepare: fake.prepare },
    children: {
      'edit a': [edit('a.txt', 'from A\n'), say('A done')],
      'edit b': [edit('a.txt', 'from B\n'), edit('c.txt', 'new\n'), say('B done')],
    },
  });
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\n', 'the project is not touched');
  assert.equal(fake.made.length, 2);
  assert.notEqual(fake.made[0].workspace, fake.made[1].workspace);
  assert.equal(readFileSync(join(fake.made[0].workspace, 'a.txt'), 'utf8'), 'from A\n');
  assert.equal(readFileSync(join(fake.made[1].workspace, 'a.txt'), 'utf8'), 'from B\n');
  const [outA, outB] = r.outputs.filter((o) => o.name === 'spawn_agent').map((o) => o.output);
  assert.match(outA, /Changed files \(1.*a\.txt/);
  assert.doesNotMatch(outA, /Warning/);
  assert.match(outB, /Changed files \(2/);
  assert.match(outB, /Warning: these changes touch files also changed by "Writer A" \(a\.txt\)/);
  const a = r.runs.find((x) => x.title === 'Writer A');
  assert.deepEqual(a.changed, ['a.txt']);
  assert.ok(a.warnings?.[0].includes('Writer B'), 'the earlier agent is told about the later overlap');
  assert.deepEqual(fake.finished.sort(), ['r1', 'r2']);
});

test('a writing subagent with no changes leaves no review and says so', async () => {
  const root = project();
  const fake = fakeReviews(root);
  const r = await run({ root, parentScript: [use(spawn('Idle', 'nothing', 'general')), say('ok')], hostCfg: { prepare: fake.prepare } });
  assert.match(r.outputs.find((o) => o.name === 'spawn_agent').output, /No files were changed/);
  assert.deepEqual(fake.finished, ['r1']);
});

test('read-only subagents run in the parent workspace, not in a copy', async () => {
  const root = project();
  const fake = fakeReviews(root);
  const r = await run({ root, parentScript: [use(spawn('Reader', 'read a', 'review')), say('ok')], hostCfg: { prepare: fake.prepare }, children: { 'read a': [use(call('read_file', { path: 'a.txt' })), say('read it')] } });
  assert.equal(fake.made.length, 0);
  assert.match(r.runs[0].transcript.find((s) => s.tool === 'read_file').result, /one/);
});

test('approvals of a subagent surface through the parent callback, titled and one at a time', async () => {
  const root = project();
  const fake = fakeReviews(root);
  let open = 0;
  let maxOpen = 0;
  const r = await run({
    root,
    access: 'auto',
    parentScript: [use(spawn('Runner 1', 'cmd 1', 'general'), spawn('Runner 2', 'cmd 2', 'general')), say('ok')],
    hostCfg: { prepare: fake.prepare },
    children: {
      'cmd 1': [use(call('run_command', { command: 'make build' })), say('r1 done')],
      'cmd 2': [use(call('run_command', { command: 'make test' })), say('r2 done')],
    },
    approve: async () => {
      open++; maxOpen = Math.max(maxOpen, open);
      await sleep(20);
      open--;
      return true;
    },
  });
  assert.equal(maxOpen, 1);
  const asked = r.seen.approvals.filter((a) => a.kind === 'command');
  assert.deepEqual(asked.map((a) => [a.command, a.agent]).sort(), [['make build', 'Runner 1'], ['make test', 'Runner 2']]);
  assert.deepEqual(state.runs.map((x) => x.command).sort(), ['make build', 'make test']);
  assert.ok(state.runs.every((x) => x.root !== root), 'commands run in the private copies');
});

test('a declined approval blocks the command in the subagent', async () => {
  const root = project();
  const fake = fakeReviews(root);
  const r = await run({
    root,
    parentScript: [use(spawn('Runner', 'cmd', 'general')), say('ok')],
    hostCfg: { prepare: fake.prepare },
    children: { cmd: [use(call('run_command', { command: 'make build' })), say('could not run')] },
    approve: async () => false,
  });
  assert.equal(state.runs.length, 0);
  assert.equal(r.runs[0].transcript.find((s) => s.tool === 'run_command').error, true);
});

test('deny rules apply to subagents unchanged: no approval is even asked', async () => {
  const root = project();
  const fake = fakeReviews(root);
  const rules = normalizeRulesConfig({ rules: [{ effect: 'deny', match: 'prefix', pattern: 'make deploy' }] });
  const r = await run({
    root,
    parentScript: [use(spawn('Deployer', 'deploy', 'general')), say('ok')],
    hostCfg: { prepare: fake.prepare, rules },
    children: { deploy: [use(call('run_command', { command: 'make deploy prod' })), say('blocked')] },
  });
  assert.equal(state.runs.length, 0);
  assert.equal(r.seen.approvals.filter((a) => a.kind === 'command').length, 0);
  assert.match(r.runs[0].transcript.find((s) => s.tool === 'run_command').result, /[Bb]locked/);
});

test('setup command of a shadow copy asks through the parent with the agent title', async () => {
  const root = project();
  const prepare = async (projectRoot, o) => {
    assert.equal(await o.approve('npm ci'), true);
    return { review: { id: 'r9', root: projectRoot, workspace: root }, setup: null };
  };
  review.list = async () => [];
  const r = await run({ root, parentScript: [use(spawn('Setup', 'x', 'general')), say('ok')], hostCfg: { prepare } });
  assert.deepEqual(r.seen.approvals.map((a) => [a.command, a.agent]), [['npm ci', 'Setup']]);
});

test('tokens of subagents are recorded through the provided hook with provider and model', async () => {
  const root = project();
  const r = await run({ root, parentScript: [use(spawn('Counter', 'count')), say('ok')], children: { count: [say('x')] } });
  assert.ok(r.seen.tokens.some(([p, m, u]) => p === 'p' && m === 'm' && u.input === 10 && u.output === 5));
  assert.equal(r.runs[0].tokens, 15);
});
