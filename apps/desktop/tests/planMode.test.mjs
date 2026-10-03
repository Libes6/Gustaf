// Plan mode: pure logic (tool filtering, plan parsing, instruction text, per-chat map), CLI flags, and the agent loop
// enforcing the mode against a scripted model that tries to call forbidden tools.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const core = await import('../src/agent/planCore.ts');
const { runAgent } = await import('../src/agent/agent.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');
const { codexArgs, cursorArgs } = await import('../src/providers/cliArgs.ts');
const { claudeArgs } = await import('../src/providers/claudeCli.ts');

const plan = { title: 'Add X', steps: [{ id: '1', text: 'Read a', files: ['a.ts'] }, { id: '2', text: 'Edit b' }], risks: ['r'], questions: ['q?'] };

test('mode tool sets: ask none, plan the read-only subagent set, agent unrestricted', () => {
  assert.deepEqual(core.modeToolNames('ask'), []);
  assert.deepEqual(core.modeToolNames('plan'), ['read_file', 'list_dir', 'search']);
  assert.equal(core.modeToolNames('agent'), null);
  assert.equal(core.modeToolNames(undefined), null);
  for (const n of ['run_command', 'edit_file', 'write_file', 'spawn_agent', 'mcp__s__t']) assert.equal(core.modeAllowsTool('plan', n), false, n);
  assert.equal(core.modeAllowsTool('plan', 'search'), true);
  assert.equal(core.modeAllowsTool('ask', 'read_file'), false);
  assert.equal(core.modeAllowsTool('agent', 'run_command'), true);
});

test('a plan block round-trips and the last block wins', () => {
  const text = `Notes\n\n${core.serializePlan(plan)}`;
  const f = core.extractPlan(text);
  assert.deepEqual(f.plan, plan);
  assert.equal(f.before.trim(), 'Notes');
  assert.equal(f.after, '');
  const two = `${core.serializePlan({ title: 'Old', steps: [{ text: 'x' }] })}\ntext\n${core.serializePlan(plan)}\nbye`;
  assert.equal(core.extractPlan(two).plan.title, 'Add X');
  assert.equal(core.extractPlan(two).after.trim(), 'bye');
});

test('unparsable or empty plan blocks give null; string steps and missing ids are accepted', () => {
  assert.equal(core.extractPlan('```mcode-plan\n{oops\n```'), null);
  assert.equal(core.extractPlan('```mcode-plan\n{"title":"t","steps":[]}\n```'), null);
  assert.equal(core.extractPlan('```mcode-plan\n{"steps":[{"text":"  "}]}\n```'), null);
  assert.equal(core.extractPlan('```json\n{"steps":["a"]}\n```'), null);
  const p = core.extractPlan('```mcode-plan\n{"steps":["a",{"text":"b","files":["x",3]},7]}\n```').plan;
  assert.equal(p.title, 'Plan');
  assert.deepEqual(p.steps, [{ id: '1', text: 'a' }, { id: '2', text: 'b', files: ['x'] }]);
});

test('an approved plan becomes an instruction that names the steps, files and risks', () => {
  const text = core.planToInstruction(plan);
  assert.match(text, /^Approved plan: Add X/);
  assert.match(text, /\n1\. Read a \(a\.ts\)\n2\. Edit b/);
  assert.match(text, /Risks to keep in mind:\n- r/);
  assert.ok(!text.includes('q?'));
});

test('per-chat mode map: Agent is the default and is not stored; bad data is ignored; the map is capped', () => {
  assert.equal(core.chatModeOf({}, 5), 'agent');
  assert.equal(core.chatModeOf({}, null), 'agent');
  let m = core.withChatMode({}, 5, 'plan');
  assert.deepEqual(m, { 5: 'plan' });
  assert.equal(core.chatModeOf(m, 5), 'plan');
  assert.deepEqual(core.withChatMode(m, 5, 'agent'), {});
  assert.deepEqual(core.normalizeChatModes({ 1: 'plan', x: 'ask', 2: 'agent', 3: 'zzz', 4: 'ask' }), { 1: 'plan', 4: 'ask' });
  assert.deepEqual(core.normalizeChatModes([1, 2]), {});
  let big = {};
  for (let i = 1; i <= core.MAX_STORED_MODES + 3; i++) big = core.withChatMode(big, i, 'plan');
  assert.equal(Object.keys(big).length, core.MAX_STORED_MODES);
  assert.equal(big['1'], undefined);
});

test('CLI flags: Cursor --plan / --mode ask, Claude plan permission mode, Codex read-only sandbox (also over full access)', () => {
  assert.ok(cursorArgs({ mode: 'plan', access: 'full' }).includes('--plan'));
  assert.equal(cursorArgs({ mode: 'plan', access: 'full' }).includes('--force'), false);
  assert.deepEqual(cursorArgs({ mode: 'ask' }).slice(5, 7), ['--mode', 'ask']);
  assert.deepEqual(cursorArgs({ access: 'readonly' }).slice(5, 7), ['--mode', 'plan']);
  assert.ok(cursorArgs({ access: 'full' }).includes('--force'));
  assert.equal(cursorArgs({ mode: 'agent', access: 'auto' }).some((a) => a === '--plan' || a === '--mode'), false);
  const perm = (a) => a[a.indexOf('--permission-mode') + 1];
  assert.equal(perm(claudeArgs({ mode: 'plan', access: 'full' })), 'plan');
  assert.equal(perm(claudeArgs({ mode: 'ask', access: 'auto' })), 'plan');
  assert.equal(perm(claudeArgs({ mode: 'agent', access: 'auto' })), 'acceptEdits');
  assert.deepEqual(codexArgs({ mode: 'plan', access: 'full' }).slice(-2), ['--sandbox', 'read-only']);
  assert.ok(codexArgs({ mode: 'ask', session: 's', access: 'full' }).includes('sandbox_mode="read-only"'));
  assert.ok(codexArgs({ mode: 'agent', access: 'full' }).includes('--dangerously-bypass-approvals-and-sandbox'));
});

// ---- agent loop ----
before(() => {
  state.reset();
  saveRulesConfig(DEFAULT_RULES);
});
let n = 0;
const call = (name, args) => ({ type: 'tool_call', id: `c${n++}`, name, args });

async function run(mode, script, extra = {}) {
  state.reset();
  saveRulesConfig(DEFAULT_RULES);
  const root = mkdtempSync(join(tmpdir(), 'plan-test-'));
  writeFileSync(join(root, 'a.txt'), 'hello');
  const offered = [];
  const systems = [];
  const outputs = [];
  let i = 0;
  const adapter = {
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      offered.push(input.tools.map((t) => t.name));
      systems.push(input.system);
      assert.equal(input.mode, mode === 'agent' ? undefined : mode);
      return script[i++] ?? { parts: [{ type: 'text', text: 'done' }] };
    },
  };
  await runAgent({
    root, history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], adapter, providerId: 'p', model: 'm', access: 'full', computerUse: false, allowlist: [],
    mode, signal: new AbortController().signal, onText: () => {},
    onMessage: async (m) => { if (m.role === 'tool') outputs.push(...m.parts.map((p) => ({ name: p.name, output: p.output, isError: !!p.isError }))); },
    approve: async () => true,
    ...extra,
  });
  return { root, offered, systems, outputs, runs: [...state.runs] };
}

test('Plan mode offers only read tools and blocks writes, commands, MCP and spawn even if the model calls them', async () => {
  const r = await run('plan', [
    { parts: [call('read_file', { path: 'a.txt' }), call('run_command', { command: 'echo hi' }), call('write_file', { path: 'new.txt', content: 'x' }), call('edit_file', { path: 'a.txt', old_string: 'hello', new_string: 'bye' }), call('spawn_agent', { title: 't', prompt: 'p', type: 'general' }), call('mcp__srv__tool', {})] },
  ]);
  assert.deepEqual(r.offered[0].sort(), ['list_dir', 'read_file', 'search', 'use_skill']);
  assert.match(r.systems[0], /Plan mode/);
  assert.match(r.systems[0], /mcode-plan/);
  const byName = Object.fromEntries(r.outputs.map((o) => [o.name, o]));
  assert.equal(byName.read_file.isError, false);
  for (const name of ['run_command', 'write_file', 'edit_file', 'spawn_agent', 'mcp__srv__tool']) {
    assert.equal(byName[name].isError, true, name);
    assert.match(byName[name].output, /^Blocked: Plan mode is read-only/, name);
  }
  assert.deepEqual(r.runs, []);
  assert.equal(existsSync(join(r.root, 'new.txt')), false);
});

test('Ask mode offers no tools at all and blocks even reads', async () => {
  const r = await run('ask', [{ parts: [call('read_file', { path: 'a.txt' }), call('run_command', { command: 'ls' })] }]);
  assert.deepEqual(r.offered[0], []);
  assert.match(r.systems[0], /Ask mode/);
  assert.deepEqual(r.outputs.map((o) => [o.isError, /^Blocked: Ask mode/.test(o.output)]), [[true, true], [true, true]]);
  assert.deepEqual(r.runs, []);
});

test('Agent mode keeps the full tool set and no mode addendum', async () => {
  const r = await run('agent', [{ parts: [call('run_command', { command: 'echo hi' })] }]);
  assert.ok(r.offered[0].includes('run_command') && r.offered[0].includes('write_file'));
  assert.doesNotMatch(r.systems[0], /Plan mode|Ask mode/);
  assert.equal(r.runs.length, 1);
});

test('subagent and scheduled runs ignore the chat mode', async () => {
  for (const extra of [{ source: 'scheduled' }, { toolNames: ['read_file', 'list_dir', 'search', 'run_command'] }]) {
    state.reset();
    const root = mkdtempSync(join(tmpdir(), 'plan-test-'));
    const seen = [];
    await runAgent({
      root, history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], providerId: 'p', model: 'm', access: 'full', computerUse: false, allowlist: [], mode: 'plan', ...extra,
      adapter: { supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: async (i) => (seen.push({ mode: i.mode, system: i.system, tools: i.tools.map((t) => t.name) }), { parts: [{ type: 'text', text: 'ok' }] }) },
      signal: new AbortController().signal, onText: () => {}, onMessage: async () => {}, approve: async () => true,
    });
    assert.equal(seen[0].mode, undefined);
    assert.doesNotMatch(seen[0].system, /Plan mode/);
    assert.ok(seen[0].tools.includes(extra.source ? 'run_command' : 'read_file'));
  }
});
