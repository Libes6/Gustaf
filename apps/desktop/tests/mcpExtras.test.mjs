// MCP follow-ups: resources (built-in list/read tools), prompts (user-invoked templates), cancellation end to end
// (HTTP client and the stdio runtime through the stub), and the HTTP client's OAuth hooks. Pure logic plus the real
// src/agent code against a scripted model and fake servers (tests/helpers/apiStub.mjs, fake fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const res = await import('../src/agent/mcp/resources.ts');
const prm = await import('../src/agent/mcp/prompts.ts');
const ts = await import('../src/agent/mcp/toolset.ts');
const { McpHttpClient } = await import('../src/agent/mcp/http.ts');
const { SIGN_IN_NEEDED } = await import('../src/agent/mcp/oauth.ts');
const rt = await import('../src/agent/mcp/runtime.ts');
const { blankServer } = await import('../src/agent/mcp/config.ts');
const { runAgent } = await import('../src/agent/agent.ts');
const { clearActionLog, getActionLog } = await import('../src/agent/actionLogStore.ts');

// ---- resources (pure) ----------------------------------------------------------------------------------------------

test('resources/list pages are validated, unique and bounded', () => {
  const list = res.normalizeResources({ resources: [{ uri: 'file:///a', name: 'a', mimeType: 'text/plain', size: 12.7 }, { uri: 'file:///a', name: 'dup' }, { name: 'no uri' }, null, { uri: 'x://b', description: 'd'.repeat(900) }, { uri: 'u'.repeat(3000) }] });
  assert.deepEqual(list.map((r) => r.uri), ['file:///a', 'x://b']);
  assert.equal(list[0].size, 12);
  assert.equal(list[1].name, 'x://b');
  assert.equal(list[1].description.length, 500);
  assert.equal(res.normalizeResources({ resources: Array.from({ length: 500 }, (_, i) => ({ uri: `r://${i}` })) }).length, res.MAX_RESOURCES);
  assert.deepEqual(res.normalizeResources(null), []);
  assert.match(res.formatResourceList(list), /^file:\/\/\/a \| a \| text\/plain \| 12 bytes$/m);
  assert.match(res.formatResourceList(Array.from({ length: 50 }, (_, i) => ({ uri: `r://${i}`, name: 'n' })), 100), /list truncated: \d+ more resources/);
  assert.equal(res.formatResourceList([]), '(this server offers no resources)');
});

test('resources/read: text is capped, blobs are described, one PNG is attached', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
  const r = res.mapReadResult({ contents: [{ uri: 'f://1', mimeType: 'text/plain', text: 'hello' }, { uri: 'f://2', mimeType: 'image/png', blob: PNG }, { uri: 'f://3', mimeType: 'image/png', blob: PNG }, { uri: 'f://4', mimeType: 'application/zip', blob: 'AAAA'.repeat(10) }] });
  assert.equal(r.image, PNG);
  assert.match(r.output, /\[resource f:\/\/1 \(text\/plain\)\]\nhello/);
  assert.match(r.output, /f:\/\/3 \(image\/png\)\] \[binary content omitted: \d+ bytes\]/);
  assert.match(r.output, /f:\/\/4 \(application\/zip\)\] \[binary content omitted: 30 bytes\]/);
  assert.ok(!r.output.includes('AAAA'), 'blob data is never passed on');
  const big = res.mapReadResult({ contents: [{ uri: 'f://x', text: 'x'.repeat(60_000) }] });
  assert.ok(big.output.length < 50_200);
  assert.match(big.output, /output truncated: \d+ more characters/);
  assert.match(res.mapReadResult({ contents: [{ uri: 'f://x', text: 'abcdef' }] }, 3).output, /^\[re\n\[output truncated: \d+ more characters\]$/);
  const huge = res.mapReadResult({ contents: [{ uri: 'f://p', mimeType: 'image/png', blob: PNG + 'A'.repeat(res.MAX_RESOURCE_IMAGE_BASE64) }] });
  assert.equal(huge.image, undefined);
  assert.match(huge.output, /too large/);
  assert.equal(res.mapReadResult({ nope: 1 }).isError, true);
  assert.equal(res.mapReadResult({ contents: [] }).output, '(empty resource)');
});

test('read_resource argument validation and tool definitions', () => {
  assert.equal(res.readResourceUri({ uri: 'file:///x' }), 'file:///x');
  for (const bad of [undefined, null, {}, { uri: '' }, { uri: 5 }, { uri: 'a\0b' }, { uri: 'u'.repeat(3000) }]) assert.throws(() => res.readResourceUri(bad));
  const defs = res.resourceToolDefs('gh', { list: 'mcp__gh__mcp_list_resources', read: 'mcp__gh__mcp_read_resource' });
  assert.deepEqual(defs.map((d) => d.name), ['mcp__gh__mcp_list_resources', 'mcp__gh__mcp_read_resource']);
  assert.deepEqual(defs[1].parameters.required, ['uri']);
  assert.deepEqual(res.resourceToolDefs('gh', { list: 'a', read: 'b' }, { list: false, read: true }).map((d) => d.name), ['b']);
});

test('namespaceTools adds the resource tools, with collision handling and policy keys', () => {
  const { defs, route } = ts.namespaceTools([{ server: { id: 's1', name: 'gh' }, tools: [{ name: 'mcp_read_resource', description: 'real tool', inputSchema: {} }], resources: { list: true, read: true } }]);
  const names = defs.map((d) => d.name);
  assert.deepEqual(names, ['mcp__gh__mcp_read_resource', 'mcp__gh__mcp_list_resources', 'mcp__gh__mcp_read_resource_2']);
  assert.equal(route.get('mcp__gh__mcp_read_resource').kind, undefined);
  assert.deepEqual(route.get('mcp__gh__mcp_list_resources'), { serverId: 's1', server: 'gh', tool: 'mcp_list_resources', kind: 'list_resources' });
  assert.deepEqual(route.get('mcp__gh__mcp_read_resource_2'), { serverId: 's1', server: 'gh', tool: 'mcp_read_resource', kind: 'read_resource' });
  // Read-only mode offers only what the user marked read-only: the policy keys are the built-in names.
  const p = { alwaysAllow: false, allowedTools: [], readOnlyTools: ['mcp_read_resource'] };
  assert.equal(ts.decideMcp(p, 'mcp_read_resource', 'readonly').action, 'ask');
  assert.equal(ts.decideMcp(p, 'mcp_list_resources', 'readonly').action, 'block');
});

// ---- prompts (pure) ------------------------------------------------------------------------------------------------

test('prompts: validation, argument handling and rendering', () => {
  const list = prm.normalizePrompts({ prompts: [{ name: 'review', title: 'Review', description: 'Review code', arguments: [{ name: 'code', required: true, description: 'The code' }, { name: 'style' }, { name: 'code' }, { nope: 1 }] }, { name: 'review' }, { name: '' }, null, { name: 'plain' }] });
  assert.deepEqual(list.map((p) => p.name), ['review', 'plain']);
  assert.deepEqual(list[0].arguments, [{ name: 'code', description: 'The code', required: true }, { name: 'style', description: '', required: false }]);
  assert.deepEqual(prm.missingPromptArgs(list[0], { code: '  ' }), ['code']);
  assert.deepEqual(prm.missingPromptArgs(list[0], { code: 'x' }), []);
  assert.deepEqual(prm.buildPromptArguments(list[0], { code: 'x', style: '', extra: 'dropped' }), { code: 'x' });
  assert.equal(prm.buildPromptArguments(list[0], { code: 'x'.repeat(20_000) }).code.length, prm.MAX_ARG_VALUE);
  // A single user message is inserted bare; anything else keeps the roles.
  assert.deepEqual(prm.renderPromptMessages({ messages: [{ role: 'user', content: { type: 'text', text: 'Review this' } }] }), { text: 'Review this', truncated: false });
  const multi = prm.renderPromptMessages({ messages: [{ role: 'user', content: { type: 'text', text: 'Q' } }, { role: 'assistant', content: { type: 'text', text: 'A' } }, { role: 'user', content: { type: 'resource', resource: { uri: 'f://x', text: 'body' } } }, { role: 'user', content: { type: 'image', data: 'xx' } }] });
  assert.equal(multi.text, 'User: Q\n\nAssistant: A\n\nUser: [resource f://x]\nbody\n\nUser: [image omitted]');
  assert.deepEqual(prm.renderPromptMessages({ messages: [{ role: 'user', content: { type: 'text', text: 'x'.repeat(30) } }] }, 10), { text: 'x'.repeat(10), truncated: true });
  assert.deepEqual(prm.renderPromptMessages({}), { text: '', truncated: false });
});

// ---- HTTP client: cancellation, list_changed, OAuth hooks ----------------------------------------------------------

const json = (obj, headers = {}, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const initResult = (id, caps = { tools: {} }) => json({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: caps, serverInfo: { name: 'remote' } } }, { 'mcp-session-id': 's1' });

test('HTTP: aborting returns at once, tells the server, and never reads the late answer', async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push(body);
    if (body?.method === 'initialize') return initResult(body.id);
    if (!body || body.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
    await gate; // a server (and a transport) that ignores the abort signal
    return json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'late' }] } });
  };
  const c = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch });
  const ctl = new AbortController();
  const p = c.request('tools/call', { name: 'slow' }, 60_000, ctl.signal);
  await new Promise((r) => setTimeout(r, 20));
  const t = Date.now();
  ctl.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.ok(Date.now() - t < 200);
  await new Promise((r) => setTimeout(r, 20));
  const cancel = calls.find((b) => b?.method === 'notifications/cancelled');
  assert.deepEqual(cancel.params, { requestId: calls.find((b) => b?.method === 'tools/call').id, reason: 'cancelled by the user' });
  release(); // the late response arrives and is dropped without effect
  await new Promise((r) => setTimeout(r, 20));
  // Already-aborted signals do not even start the call.
  const done = new AbortController();
  done.abort();
  const n = calls.length;
  await assert.rejects(c.request('tools/call', { name: 'x' }, 60_000, done.signal), { name: 'AbortError' });
  assert.ok(!calls.slice(n).some((b) => b?.method === 'tools/call'), 'an aborted signal sends nothing');
});

test('HTTP: resources and prompts list_changed bump their own epochs', async () => {
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.method === 'initialize') return initResult(body.id);
    if (!body || body.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
    const sse = ['notifications/resources/list_changed', 'notifications/prompts/list_changed', 'notifications/prompts/list_changed'].map((method) => `data: ${JSON.stringify({ jsonrpc: '2.0', method })}\n\n`).join('') + `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} })}\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const c = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch });
  await c.request('ping', {});
  assert.deepEqual([c.toolsEpoch, c.resourcesEpoch, c.promptsEpoch], [0, 1, 2]);
});

test('HTTP OAuth hooks: bearer header, one refresh and retry after 401, then sign-in needed', async () => {
  let token = 'old';
  let refreshes = 0;
  const seen = [];
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push(init.headers.Authorization);
    if (init.headers.Authorization !== 'Bearer new') return new Response('no', { status: 401 });
    if (body?.method === 'initialize') return initResult(body.id);
    if (!body || body.method?.startsWith('notifications/')) return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: body.id, result: { ok: true } });
  };
  const auth = { header: async () => `Bearer ${token}`, refresh: async () => (refreshes++, (token = 'new'), true) };
  const c = new McpHttpClient({ url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer configured' }, fetch, auth });
  assert.deepEqual(await c.request('ping', {}), { ok: true });
  assert.equal(refreshes, 1);
  assert.deepEqual(seen.slice(0, 2), ['Bearer old', 'Bearer new']);
  assert.ok(seen.every((h) => h !== 'Bearer configured'), 'the OAuth token replaces a configured Authorization header');
  // A refresh that fails (or tokens that stay rejected) end in the sign-in message, not in a retry loop.
  const bad = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch, auth: { header: async () => 'Bearer nope', refresh: async () => false } });
  await assert.rejects(bad.request('ping', {}), new RegExp(SIGN_IN_NEEDED));
  const stuck = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch, auth: { header: async () => 'Bearer nope', refresh: async () => true } });
  await assert.rejects(stuck.request('ping', {}), new RegExp(SIGN_IN_NEEDED));
  // Without OAuth a 401 stays the plain HTTP error.
  const plain = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch });
  await assert.rejects(plain.request('ping', {}), /HTTP 401/);
});

// ---- the agent: resource tools, cancellation, prompts ---------------------------------------------------------------

let seq = 0;
async function addServer(over = {}) {
  const id = `ex${++seq}`;
  const server = { ...blankServer(id, 'stdio'), name: over.name ?? 'docs', command: 'node', args: ['s.js'], ...over.config };
  state.mcp.servers[id] = {
    tools: [{ name: 'search', description: 'Search', inputSchema: { type: 'object' } }, { name: 'slow', description: 'Hangs', inputSchema: { type: 'object' } }],
    call: (name) => ({ content: [{ type: 'text', text: `${name} ok` }] }),
    resources: [{ uri: 'doc://readme', name: 'README', mimeType: 'text/markdown', size: 42 }],
    read: (uri) => ({ contents: [{ uri, mimeType: 'text/markdown', text: '# Title\n' + 'x'.repeat(60_000) }] }),
    prompts: [{ name: 'review', description: 'Review code', arguments: [{ name: 'code', required: true }] }],
    getPrompt: (name, args) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Please review: ${args.code}` } }] }),
    ...over.fake,
  };
  await rt.saveMcpServer(server);
  return id;
}

async function run(script, o = {}) {
  clearActionLog();
  const approvals = [];
  const outputs = [];
  const offered = [];
  let i = 0;
  const signal = o.signal ?? new AbortController().signal;
  const p = runAgent({
    root: mkdtempSync(join(tmpdir(), 'mcp-extra-')),
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: {
      supportsComputer: false,
      supportsReasoning: () => false,
      listModels: async () => [],
      turn: async (input) => {
        offered.push(input.tools.map((t) => t.name));
        const next = script[i++];
        return typeof next === 'function' ? next() : next ?? { parts: [{ type: 'text', text: 'done' }] };
      },
    },
    providerId: 'p',
    model: 'm',
    access: o.access ?? 'auto',
    computerUse: false,
    allowlist: [],
    signal,
    onText: () => {},
    onMessage: async (m) => {
      if (m.role === 'tool') outputs.push(...m.parts.map((p) => ({ output: p.output, isError: !!p.isError, ...(p.image ? { image: p.image } : {}) })));
    },
    approve: async (req) => (approvals.push(req), o.approve ? o.approve(req) : true),
  });
  if (o.wait === false) return { p, offered, outputs, approvals };
  await p;
  return { offered, outputs, approvals, log: getActionLog().entries };
}
const call = (name, args = {}) => ({ parts: [{ type: 'tool_call', id: `c${Math.random()}`, name, args }] });

test('servers with resources get list/read tools; calls ask like tool calls; output is capped', async () => {
  state.reset();
  const id = await addServer();
  const r = await run([call('mcp__docs__mcp_list_resources'), call('mcp__docs__mcp_read_resource', { uri: 'doc://readme' })]);
  assert.ok(r.offered[0].includes('mcp__docs__mcp_list_resources') && r.offered[0].includes('mcp__docs__mcp_read_resource'));
  assert.deepEqual(r.approvals.map((a) => [a.kind, a.tool, a.args]), [['mcp', 'mcp_list_resources', {}], ['mcp', 'mcp_read_resource', { uri: 'doc://readme' }]]);
  assert.match(r.outputs[0].output, /^doc:\/\/readme \| README \| text\/markdown \| 42 bytes$/);
  assert.match(r.outputs[1].output, /^\[resource doc:\/\/readme \(text\/markdown\)\]\n# Title/);
  assert.match(r.outputs[1].output, /output truncated/);
  assert.ok(r.outputs[1].output.length < 50_200);
  assert.equal(r.log.at(-1).tool, 'mcp__docs__mcp_read_resource');
  // "Always allow" by the built-in name skips the question.
  await rt.patchMcpServer(id, { allowedTools: ['mcp_read_resource'] });
  const r2 = await run([call('mcp__docs__mcp_read_resource', { uri: 'doc://readme' })]);
  assert.equal(r2.approvals.length, 0);
  assert.equal(r2.log.at(-1).rule, 'always allow MCP tool docs/mcp_read_resource');
  // A missing uri is a tool error, not a request.
  const before = state.mcp.requests.length;
  const r3 = await run([call('mcp__docs__mcp_read_resource', {})]);
  assert.equal(r3.outputs[0].isError, true);
  assert.ok(!state.mcp.requests.slice(before).some((q) => q.method === 'resources/read'));
});

test('resource tools: read-only mode needs the read-only mark; servers without resources get none', async () => {
  state.reset();
  const id = await addServer();
  let r = await run([], { access: 'readonly' });
  assert.ok(!r.offered[0].some((n) => n.includes('resources') || n.includes('resource')));
  await rt.patchMcpServer(id, { readOnlyTools: ['mcp_list_resources'] });
  r = await run([], { access: 'readonly' });
  assert.ok(r.offered[0].includes('mcp__docs__mcp_list_resources') && !r.offered[0].includes('mcp__docs__mcp_read_resource'));
  state.reset();
  await addServer({ fake: { resources: undefined, prompts: undefined } });
  r = await run([]);
  assert.ok(!r.offered[0].some((n) => n.includes('resource')));
});

test('resources/list is cached until resources/list_changed', async () => {
  state.reset();
  const id = await addServer();
  const server = (await rt.loadMcpConfig()).servers.find((s) => s.id === id);
  const count = () => state.mcp.requests.filter((q) => q.method === 'resources/list').length;
  assert.equal((await rt.listMcpResources(server)).length, 1);
  await rt.listMcpResources(server);
  assert.equal(count(), 1);
  state.mcp.servers[id].resourcesEpoch = 1;
  state.mcp.servers[id].resources = [{ uri: 'doc://a', name: 'a' }, { uri: 'doc://b', name: 'b' }];
  assert.equal((await rt.listMcpResources(server)).length, 2);
  assert.equal(count(), 2);
});

test('aborting a run cancels the in-flight stdio call and returns control immediately', async () => {
  state.reset();
  await addServer({ fake: { hang: (name) => name === 'slow' } });
  const ctl = new AbortController();
  const t0 = Date.now();
  const r = await run([call('mcp__docs__slow')], { signal: ctl.signal, wait: false, approve: () => true });
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(state.mcp.cancels.length, 0);
  ctl.abort();
  await r.p;
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(state.mcp.cancels.length, 1);
  const req = state.mcp.requests.find((q) => q.method === 'tools/call');
  assert.deepEqual(state.mcp.cancels[0].requestKey, req.requestKey);
  assert.ok(req.requestKey);
});

test('prompts are listed for the picker and fetched only when the user asks', async () => {
  state.reset();
  const id = await addServer();
  await addServer({ name: 'bare', fake: { prompts: undefined } });
  const groups = await rt.listPromptsForPicker(null);
  const docs = groups.find((g) => g.server.name === 'docs');
  assert.deepEqual(docs.prompts.map((p) => p.name), ['review']);
  assert.deepEqual(groups.find((g) => g.server.name === 'bare').prompts, []);
  assert.ok(!state.mcp.requests.some((q) => q.method === 'prompts/get'), 'listing never renders a prompt');
  const out = await rt.getMcpPrompt(docs.server, docs.prompts[0], { code: 'fn()', ignored: 'x' });
  assert.equal(out.text, 'Please review: fn()');
  assert.deepEqual(state.mcp.requests.find((q) => q.method === 'prompts/get').params, { name: 'review', arguments: { code: 'fn()' } });
  // Prompts are not offered to the model as tools.
  const r = await run([]);
  assert.ok(!r.offered[0].some((n) => n.includes('review') || n.includes('prompt')));
  await rt.removeMcpServer(id);
});
