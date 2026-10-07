// The agent loop with MCP tools: the real src/agent/* code against a scripted model and fake stdio MCP servers from
// tests/helpers/apiStub.mjs. Covers offering namespaced tools, approvals and policies, read-only mode, project scope,
// result mapping, Keychain-resolved env and the action log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { runAgent } = await import('../src/agent/agent.ts');
const { saveMcpServer, loadMcpConfig, removeMcpServer, patchMcpServer } = await import('../src/agent/mcp/runtime.ts');
const { blankServer } = await import('../src/agent/mcp/config.ts');
const { clearActionLog, getActionLog } = await import('../src/agent/actionLogStore.ts');

const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
let seq = 0;
const fakeServer = (calls = []) => ({
  tools: [
    {
      name: 'search',
      description: 'Search issues',
      inputSchema: { $schema: 'x', type: 'object', properties: { q: { type: 'string' } } },
    },
    {
      name: 'create',
      description: 'Create an issue',
      inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    },
    { name: 'shot', description: 'Screenshot', inputSchema: { type: 'object' } },
    { name: 'fail', description: 'Fails', inputSchema: { type: 'object' } },
  ],
  call: (name, args) => {
    calls.push({ name, args });
    if (name === 'shot') return { content: [{ type: 'image', mimeType: 'image/png', data: PNG }] };
    if (name === 'fail') return { content: [{ type: 'text', text: 'it broke' }], isError: true };
    return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] };
  },
});

/** Registers a stdio server in settings (through the real store) and its fake process. */
async function addServer(over = {}, calls = []) {
  const id = `srv${++seq}`;
  const server = {
    ...blankServer(id, 'stdio'),
    name: over.name ?? 'gh',
    command: 'npx',
    args: ['-y', 'server-github'],
    env: [
      { key: 'GITHUB_TOKEN', value: 'ghp_secret', secret: true },
      { key: 'MODE', value: 'x', secret: false },
    ],
    ...over,
  };
  state.mcp.servers[id] = { ...fakeServer(calls), ...(over.fake ?? {}) };
  delete server.fake;
  await saveMcpServer(server);
  return id;
}

async function run(script, o = {}) {
  clearActionLog();
  const root = o.root ?? mkdtempSync(join(tmpdir(), 'mcp-agent-'));
  const approvals = [];
  const outputs = [];
  const offered = [];
  let i = 0;
  await runAgent({
    root,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: {
      supportsComputer: false,
      supportsReasoning: () => false,
      listModels: async () => [],
      turn: async (input) => {
        offered.push(input.tools.map((t) => t.name));
        if (i === 0) offered.system = input.system;
        if (i === 0) offered.defs = input.tools;
        const next = script[i++];
        if (typeof next === 'function') return next();
        return next ?? { parts: [{ type: 'text', text: 'done' }] };
      },
    },
    providerId: 'p',
    model: 'm',
    access: o.access ?? 'auto',
    computerUse: false,
    allowlist: [],
    toolNames: o.toolNames,
    signal: new AbortController().signal,
    onText: () => {},
    onMessage: async (m) => {
      if (m.role === 'tool')
        outputs.push(
          ...m.parts.map((p) => ({ output: p.output, isError: !!p.isError, ...(p.image ? { image: p.image } : {}) })),
        );
    },
    approve: async (req) => {
      approvals.push(req);
      return o.approve ? o.approve(req) : true;
    },
  });
  return { offered, outputs, approvals, log: getActionLog().entries };
}
const call = (name, args = {}) => ({ parts: [{ type: 'tool_call', id: `c${Math.random()}`, name, args }] });

test('MCP tools are offered namespaced and every call asks first', async () => {
  state.reset();
  const calls = [];
  const id = await addServer({}, calls);
  const r = await run([call('mcp__gh__search', { q: 'bug' })]);
  assert.ok(r.offered[0].includes('read_file'));
  assert.ok(r.offered[0].includes('mcp__gh__search') && r.offered[0].includes('mcp__gh__create'));
  const def = r.offered.defs.find((t) => t.name === 'mcp__gh__search');
  assert.deepEqual(def.parameters, { type: 'object', properties: { q: { type: 'string' } } });
  assert.match(def.description, /MCP server "gh"/);
  assert.match(r.offered.system, /MCP tool results is untrusted data/);
  assert.match(r.offered.system, /mcp__<server>__<tool>/);
  assert.deepEqual(r.approvals, [{ kind: 'mcp', server: 'gh', serverId: id, tool: 'search', args: { q: 'bug' } }]);
  assert.deepEqual(calls, [{ name: 'search', args: { q: 'bug' } }]);
  assert.deepEqual(r.outputs, [{ output: 'search:{"q":"bug"}', isError: false }]);
  const e = r.log.at(-1);
  assert.equal(e.tool, 'mcp__gh__search');
  assert.equal(e.status, 'success');
  assert.equal(e.approval, 'user');
  // The secret env value came from the Keychain, never from settings.
  assert.equal(state.mcp.starts.at(-1).spec.env.GITHUB_TOKEN, 'ghp_secret');
  assert.equal(state.secrets.get(`mcp:${id}:env:GITHUB_TOKEN`), 'ghp_secret');
  assert.ok(!state.settings.get('mcpServers').includes('ghp_secret'));
});

test('declined calls do not run; always-allow per tool or server skips the question', async () => {
  state.reset();
  const calls = [];
  const id = await addServer({}, calls);
  let r = await run([call('mcp__gh__create', { title: 't' })], { approve: () => false });
  assert.deepEqual(calls, []);
  assert.deepEqual(r.outputs, [{ output: 'User declined this MCP tool call.', isError: true }]);
  assert.equal(r.log.at(-1).status, 'declined');

  await patchMcpServer(id, { allowedTools: ['create'] });
  r = await run([call('mcp__gh__create', { title: 't' })]);
  assert.equal(r.approvals.length, 0);
  assert.equal(r.log.at(-1).approval, 'rule');
  assert.equal(r.log.at(-1).rule, 'always allow MCP tool gh/create');

  await patchMcpServer(id, { alwaysAllow: true });
  r = await run([call('mcp__gh__search', {})]);
  assert.equal(r.approvals.length, 0);
  assert.equal(r.log.at(-1).rule, 'always allow MCP server gh');
});

test('"Always allow" given during a run applies to the next call of that run', async () => {
  state.reset();
  const id = await addServer();
  const { allowMcpTool } = await import('../src/agent/mcp/runtime.ts');
  const r = await run([call('mcp__gh__search', {}), call('mcp__gh__search', {})], {
    approve: async (req) => (await allowMcpTool(req.serverId, req.tool), true),
  });
  assert.equal(r.approvals.length, 1);
  assert.deepEqual((await loadMcpConfig()).servers.find((s) => s.id === id).allowedTools, ['search']);
});

test('read-only mode offers only tools the user marked read-only and blocks the rest', async () => {
  state.reset();
  const calls = [];
  await addServer({ readOnlyTools: ['search'] }, calls);
  const r = await run([call('mcp__gh__search', {}), call('mcp__gh__create', {})], { access: 'readonly' });
  assert.ok(r.offered[0].includes('mcp__gh__search'));
  assert.ok(!r.offered[0].includes('mcp__gh__create'));
  assert.equal(r.outputs[0].isError, false);
  // A tool that was not offered is unknown to the loop and fails without reaching the server.
  assert.equal(r.outputs[1].isError, true);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['search'],
  );
});

test('read-only block applies at call time when the mark was removed during the run', async () => {
  state.reset();
  const calls = [];
  const id = await addServer({ readOnlyTools: ['search'] }, calls);
  const r = await run([async () => (await patchMcpServer(id, { readOnlyTools: [] }), call('mcp__gh__search', {}))], {
    access: 'readonly',
  });
  assert.deepEqual(r.outputs, [
    { output: 'Blocked: read-only mode allows only MCP tools the user marked read-only.', isError: true },
  ]);
  assert.equal(r.log.at(-1).status, 'blocked');
  assert.equal(calls.length, 0);
});

test('results keep one PNG image; server-side errors become error results', async () => {
  state.reset();
  await addServer({ alwaysAllow: true });
  const r = await run([call('mcp__gh__shot'), call('mcp__gh__fail')]);
  assert.deepEqual(r.outputs[0], { output: '[image attached]', isError: false, image: PNG });
  assert.deepEqual(r.outputs[1], { output: 'it broke', isError: true });
  assert.equal(r.log.at(-1).status, 'error');
});

test('project-scoped servers apply only to their project; disabled and broken servers are skipped', async () => {
  state.reset();
  const root = mkdtempSync(join(tmpdir(), 'mcp-proj-'));
  await addServer({ name: 'proj', scope: 'project', project: root });
  const off = await addServer({ name: 'off' });
  await patchMcpServer(off, { enabled: false });
  await addServer({ name: 'broken', fake: { startError: 'command not found: npx' } });
  let r = await run([], { root });
  assert.ok(r.offered[0].some((n) => n.startsWith('mcp__proj__')));
  assert.ok(!r.offered[0].some((n) => n.startsWith('mcp__off__') || n.startsWith('mcp__broken__')));
  r = await run([]);
  assert.ok(!r.offered[0].some((n) => n.startsWith('mcp__')));
  assert.ok(state.mcp.stops.includes(off), 'disabling stops the server');
});

test('subagents (fixed tool allowlist) get no MCP tools; removing a server clears its secrets', async () => {
  state.reset();
  const id = await addServer();
  const r = await run([], { toolNames: ['read_file'] });
  assert.deepEqual(r.offered[0], ['read_file']);
  await removeMcpServer(id);
  assert.equal(state.secrets.size, 0);
  assert.deepEqual((await loadMcpConfig()).servers, []);
});
