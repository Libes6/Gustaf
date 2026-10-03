// Pure MCP logic: config import/validation and secret splitting, JSON-RPC parsing and SSE framing, schema sanitizing,
// tool-name namespacing, the approval policy, result mapping, and the HTTP client against a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const cfg = await import('../src/agent/mcp/config.ts');
const proto = await import('../src/agent/mcp/protocol.ts');
const ts = await import('../src/agent/mcp/toolset.ts');
const { McpHttpClient } = await import('../src/agent/mcp/http.ts');

let n = 0;
const newId = () => `s${++n}`;

test('imports the Claude Desktop / Cursor mcpServers shape', () => {
  const text = JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abc', LOG_LEVEL: 'info' } },
      'my db!': { command: 'uvx mcp-server-sqlite --db x.db' },
      remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t0k', 'X-Team': 'core' } },
      legacy: { type: 'sse', url: 'https://example.com/sse' },
      off: { command: 'node', args: ['s.js'], disabled: true },
      broken: { args: ['x'] },
      plain: { url: 'http://example.com/mcp' },
    },
  });
  const { servers, errors } = cfg.parseImport(text, [], newId);
  assert.deepEqual(servers.map((s) => s.name), ['github', 'my_db', 'remote', 'off']);
  const [gh, db, remote, off] = servers;
  assert.equal(gh.transport, 'stdio');
  assert.deepEqual(gh.args, ['-y', '@modelcontextprotocol/server-github']);
  assert.deepEqual(gh.env, [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', value: 'ghp_abc', secret: true }, { key: 'LOG_LEVEL', value: 'info', secret: false }]);
  assert.equal(db.command, 'uvx');
  assert.deepEqual(db.args, ['mcp-server-sqlite', '--db', 'x.db']);
  assert.deepEqual(remote.headers, [{ key: 'Authorization', value: 'Bearer t0k', secret: true }, { key: 'X-Team', value: 'core', secret: false }]);
  assert.equal(off.enabled, false);
  assert.equal(gh.enabled, true);
  assert.equal(gh.scope, 'global');
  assert.deepEqual(errors, [{ name: 'legacy', code: 'sse' }, { name: 'broken', code: 'command' }, { name: 'plain', code: 'url' }]);
});

test('import accepts VS Code "servers", bare maps and snippets; names stay unique', () => {
  const existing = [{ ...cfg.blankServer('x', 'stdio'), name: 'github', command: 'a' }];
  assert.equal(cfg.parseImport('{"servers":{"a":{"command":"x"}}}', [], newId).servers[0].name, 'a');
  assert.equal(cfg.parseImport('{"a":{"command":"x"}}', [], newId).servers[0].name, 'a');
  assert.equal(cfg.parseImport('"github": {"command": "npx"},', existing, newId).servers[0].name, 'github_2');
  assert.deepEqual(cfg.parseImport('not json', [], newId).errors, [{ name: '', code: 'json' }]);
  assert.deepEqual(cfg.parseImport('', [], newId).errors, [{ name: '', code: 'empty' }]);
  assert.deepEqual(cfg.parseImport('{"command":"npx"}', [], newId).errors, [{ name: '', code: 'invalid' }]);
  assert.deepEqual(cfg.parseImport('{"a":{"command":"x","env":{"BAD-KEY":"1"}}}', [], newId).errors, [{ name: 'a', code: 'envKey' }]);
});

test('validation catches names, urls, headers and project scope', () => {
  const s = { ...cfg.blankServer('1', 'http'), name: 'ok', url: 'https://x.dev/mcp' };
  assert.deepEqual(cfg.validateServer(s), []);
  assert.deepEqual(cfg.validateServer({ ...s, name: 'has space' }), ['name']);
  assert.deepEqual(cfg.validateServer(s, [{ ...s, id: '2', name: 'OK' }]), ['nameTaken']);
  assert.deepEqual(cfg.validateServer({ ...s, url: 'http://localhost:3000/mcp' }), []);
  assert.deepEqual(cfg.validateServer({ ...s, url: 'ftp://x' }), ['url']);
  assert.deepEqual(cfg.validateServer({ ...s, headers: [{ key: 'X: y', value: '1', secret: false }] }), ['headerName']);
  assert.deepEqual(cfg.validateServer({ ...s, headers: [{ key: 'X', value: 'a\r\nInjected: 1', secret: false }] }), ['value']);
  assert.deepEqual(cfg.validateServer({ ...s, scope: 'project' }), ['project']);
  assert.deepEqual(cfg.validateServer({ ...s, scope: 'project', project: '/p' }), []);
  const st = { ...cfg.blankServer('3', 'stdio'), name: 'st', command: '' };
  assert.deepEqual(cfg.validateServer(st), ['command']);
  assert.deepEqual(cfg.validateServer({ ...st, command: 'x', cwd: 'relative' }), ['cwd']);
});

test('secrets leave the stored config; normalize never reads a secret value', () => {
  const s = { ...cfg.blankServer('id1', 'stdio'), name: 'gh', command: 'npx', env: [{ key: 'TOKEN', value: 'ghp_x', secret: true }, { key: 'MODE', value: 'a', secret: false }, { key: 'KEEP', secret: true }] };
  const { server, secrets } = cfg.splitSecrets(s);
  assert.deepEqual(server.env, [{ key: 'TOKEN', secret: true }, { key: 'MODE', secret: false, value: 'a' }, { key: 'KEEP', secret: true }]);
  assert.deepEqual(secrets, [{ id: 'mcp:id1:env:TOKEN', value: 'ghp_x' }]);
  assert.ok(!JSON.stringify(server).includes('ghp_x'));
  // A secret value smuggled into settings is dropped on load.
  const loaded = cfg.normalizeConfig({ servers: [{ ...server, env: [{ key: 'TOKEN', value: 'leak', secret: true }] }, { id: 'bad' }, 'junk'] });
  assert.equal(loaded.servers.length, 1);
  assert.deepEqual(loaded.servers[0].env, [{ key: 'TOKEN', secret: true }]);
  // Removing or un-secreting an entry frees its Keychain item.
  const next = { ...server, env: [{ key: 'MODE', secret: false, value: 'a' }, { key: 'KEEP', secret: false, value: 'x' }] };
  assert.deepEqual(cfg.staleSecretIds(server, next), ['mcp:id1:env:TOKEN', 'mcp:id1:env:KEEP']);
  assert.deepEqual(cfg.staleSecretIds(server, null), ['mcp:id1:env:TOKEN', 'mcp:id1:env:KEEP']);
});

test('servers in scope: enabled global ones plus those of the project', () => {
  const base = { ...cfg.blankServer('a', 'stdio'), command: 'x' };
  const config = { servers: [
    { ...base, id: '1', name: 'g' },
    { ...base, id: '2', name: 'p', scope: 'project', project: '/proj' },
    { ...base, id: '3', name: 'q', scope: 'project', project: '/other' },
    { ...base, id: '4', name: 'off', enabled: false },
  ] };
  assert.deepEqual(cfg.serversFor(config, '/proj').map((s) => s.name), ['g', 'p']);
  assert.deepEqual(cfg.serversFor(config, null).map((s) => s.name), ['g']);
});

test('JSON-RPC classification and bodies', () => {
  assert.deepEqual(proto.classify({ jsonrpc: '2.0', id: 1, result: { a: 1 } }), { kind: 'response', id: 1, result: { a: 1 } });
  assert.deepEqual(proto.classify({ jsonrpc: '2.0', id: 'x', error: { code: -32601, message: 'nope' } }), { kind: 'response', id: 'x', error: { code: -32601, message: 'nope' } });
  assert.deepEqual(proto.classify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }), { kind: 'notification', method: 'notifications/tools/list_changed' });
  assert.deepEqual(proto.classify({ jsonrpc: '2.0', id: 3, method: 'ping' }), { kind: 'request', id: 3, method: 'ping' });
  assert.equal(proto.classify({ id: 1, result: 1 }).kind, 'invalid');
  assert.equal(proto.classify({ jsonrpc: '2.0', id: 1 }).kind, 'invalid');
  assert.equal(proto.classify({ jsonrpc: '2.0', id: {}, result: 1 }).kind, 'invalid');
  assert.equal(proto.parseBody('[{"jsonrpc":"2.0","id":1,"result":1},{"jsonrpc":"2.0","method":"m"}]').length, 2);
  assert.equal(proto.parseBody('{oops')[0].kind, 'invalid');
  assert.deepEqual(proto.request(1, 'tools/list'), { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.throws(() => proto.encode({ big: 'x'.repeat(proto.MAX_OUTGOING_BYTES + 1) }), /exceeds/);
  assert.deepEqual(proto.answerServerRequest({ kind: 'request', id: 9, method: 'ping' }), { jsonrpc: '2.0', id: 9, result: {} });
  assert.equal(proto.answerServerRequest({ kind: 'request', id: 9, method: 'sampling/createMessage' }).error.code, -32601);
  assert.throws(() => proto.checkInitialize({ protocolVersion: '1999-01-01' }), /unsupported/);
  assert.equal(proto.checkInitialize({ protocolVersion: '2025-03-26', serverInfo: { name: 'x' } }).serverInfo.name, 'x');
});

test('SSE decoder: split chunks, CRLF, multi-line data, size cap', () => {
  const d = new proto.SseDecoder(100);
  assert.deepEqual(d.push('event: message\r\ndata: {"a"'), []);
  assert.deepEqual(d.push(':1}\r\n\r\ndata: x\ndata: y\n\n: comment\n\n'), ['{"a":1}', 'x\ny']);
  assert.throws(() => new proto.SseDecoder(10).push('data: ' + 'z'.repeat(20)), /exceeded/);
});

test('schema sanitizing keeps property names, drops meta keywords and top-level combinators', () => {
  const raw = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties: { examples: { type: 'string', description: 'a property called examples' }, n: { type: 'number', examples: [1] } },
    required: ['examples', 3],
    anyOf: [{ required: ['n'] }],
  };
  const { schema, note } = ts.sanitizeSchema(raw);
  assert.equal(note, undefined);
  assert.deepEqual(schema, { type: 'object', properties: { examples: { type: 'string', description: 'a property called examples' }, n: { type: 'number' } }, required: ['examples'] });
  assert.deepEqual(ts.sanitizeSchema(undefined), { schema: { type: 'object', properties: {}, additionalProperties: true }, note: 'invalid' });
  assert.equal(ts.sanitizeSchema({ type: 'string' }).note, 'invalid');
  assert.deepEqual(ts.sanitizeSchema({}).schema, { type: 'object', properties: {} });
  // Too large: descriptions go first, then the schema becomes permissive.
  const wordy = { type: 'object', properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`p${i}`, { type: 'string', description: 'd'.repeat(500) }])) };
  const cut = ts.sanitizeSchema(wordy);
  assert.equal(cut.note, 'truncated');
  assert.deepEqual(cut.schema.properties.p0, { type: 'string' });
  const huge = { type: 'object', properties: Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`property_${i}`, { type: 'string', enum: ['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'] }])) };
  assert.deepEqual(ts.sanitizeSchema(huge).schema, { type: 'object', properties: {}, additionalProperties: true });
  // Depth is bounded.
  let deep = { type: 'object' };
  for (let i = 0; i < 40; i++) deep = { type: 'object', properties: { x: deep } };
  assert.ok(JSON.stringify(ts.sanitizeSchema(deep).schema).length < 2000);
});

test('tool names are namespaced, valid for every provider and never collide', () => {
  assert.equal(ts.mcpToolName('github', 'create_issue'), 'mcp__github__create_issue');
  assert.equal(ts.mcpToolName('fs', 'read.file v2'), 'mcp__fs__read_file_v2');
  const long = ts.mcpToolName('server', 'x'.repeat(100));
  assert.equal(long.length, 64);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(ts.mcpToolName('server', 'x'.repeat(100)), ts.mcpToolName('server', 'x'.repeat(99) + 'y'));
  const tools = (names) => names.map((name) => ({ name, description: 'd', inputSchema: { type: 'object' } }));
  const { defs, route } = ts.namespaceTools([
    { server: { id: 'a', name: 'fs' }, tools: tools(['read.file', 'read_file', 'list']) },
    { server: { id: 'b', name: 'fs' }, tools: tools(['list']) },
  ], ['read_file']);
  assert.deepEqual(defs.map((d) => d.name), ['mcp__fs__read_file', 'mcp__fs__read_file_2', 'mcp__fs__list', 'mcp__fs__list_2']);
  assert.deepEqual(route.get('mcp__fs__read_file_2'), { serverId: 'a', server: 'fs', tool: 'read_file' });
  assert.deepEqual(route.get('mcp__fs__list_2'), { serverId: 'b', server: 'fs', tool: 'list' });
  assert.match(defs[0].description, /^\[MCP server "fs", tool "read\.file"\] d$/);
  const many = ts.namespaceTools([{ server: { id: 'a', name: 'big' }, tools: tools(Array.from({ length: 70 }, (_, i) => `t${i}`)) }]);
  assert.equal(many.defs.length, ts.MAX_TOOLS_PER_SERVER);
  assert.equal(many.dropped, 70 - ts.MAX_TOOLS_PER_SERVER);
});

test('tools/list validation drops unnamed and duplicate tools', () => {
  const list = ts.normalizeTools({ tools: [{ name: 'a', description: 'x', annotations: { readOnlyHint: true, title: 'A' } }, { name: 'a' }, { description: 'no name' }, null, { name: 'b' }] });
  assert.deepEqual(list, [{ name: 'a', title: 'A', description: 'x', inputSchema: undefined, readOnlyHint: true }, { name: 'b', description: '', inputSchema: undefined }]);
  assert.deepEqual(ts.normalizeTools(null), []);
});

test('approval policy: ask by default, always-allow per server or tool, read-only needs the user mark', () => {
  const p = { alwaysAllow: false, allowedTools: ['search'], readOnlyTools: ['search', 'get'] };
  assert.deepEqual(ts.decideMcp(p, 'create', 'auto'), { action: 'ask' });
  assert.deepEqual(ts.decideMcp(p, 'create', 'full'), { action: 'ask' });
  assert.deepEqual(ts.decideMcp(p, 'search', 'auto'), { action: 'allow', reason: 'tool' });
  assert.deepEqual(ts.decideMcp({ ...p, alwaysAllow: true }, 'create', 'auto'), { action: 'allow', reason: 'server' });
  assert.deepEqual(ts.decideMcp({ ...p, alwaysAllow: true }, 'create', 'readonly'), { action: 'block', reason: 'readonly' });
  assert.deepEqual(ts.decideMcp(p, 'get', 'readonly'), { action: 'ask' });
  assert.deepEqual(ts.decideMcp(p, 'search', 'readonly'), { action: 'allow', reason: 'tool' });
});

test('call results map to text, one PNG image and notes, with caps', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUg==';
  const r = ts.mapCallResult({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', mimeType: 'image/png', data: png },
      { type: 'image', mimeType: 'image/png', data: png },
      { type: 'image', mimeType: 'image/jpeg', data: '/9j/' },
      { type: 'audio', mimeType: 'audio/wav', data: 'x' },
      { type: 'resource_link', uri: 'file:///a.txt', name: 'a.txt', mimeType: 'text/plain', description: 'A file' },
      { type: 'resource', resource: { uri: 'mem://x', text: 'inline' } },
      { type: 'resource', resource: { uri: 'mem://b', mimeType: 'application/zip', blob: 'AAAA' } },
      { type: 'weird' },
    ],
  });
  assert.equal(r.image, png);
  assert.equal(r.isError, false);
  assert.equal(r.output, [
    'hello',
    '[image attached]',
    '[image/png omitted: only one image per result]',
    '[image/jpeg omitted: unsupported format]',
    '[audio/wav omitted]',
    '[resource link] a.txt <file:///a.txt> (text/plain) - A file',
    '[resource mem://x]\ninline',
    '[binary resource mem://b (application/zip), 3 bytes omitted]',
    '[weird content omitted]',
  ].join('\n'));
  assert.deepEqual(ts.mapCallResult({ content: [], structuredContent: { a: 1 } }), { output: '{"a":1}', isError: false });
  assert.deepEqual(ts.mapCallResult({ content: [{ type: 'text', text: 'boom' }], isError: true }), { output: 'boom', isError: true });
  assert.deepEqual(ts.mapCallResult('nope'), { output: 'Invalid MCP result.', isError: true });
  assert.equal(ts.mapCallResult({ content: [] }).output, '(no output)');
  const big = ts.mapCallResult({ content: [{ type: 'text', text: 'y'.repeat(60_000) }] });
  assert.ok(big.output.length < 50_100 && big.output.endsWith('[output truncated: 10000 more characters]'));
});

// ---- HTTP transport against a fake fetch ----

function fakeHttp(handler) {
  const calls = [];
  const fetch = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body });
    return handler(body, init, calls);
  };
  return { fetch, calls };
}
const json = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const sseResponse = (events) => new Response(new ReadableStream({
  start(c) {
    const enc = new TextEncoder();
    for (const e of events) c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(e)}\n\n`));
    c.close();
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const init = (id) => ({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote' } } });

test('HTTP client: handshake, session header, SSE responses and list_changed', async () => {
  const { fetch, calls } = fakeHttp((body) => {
    if (!body) return new Response(null, { status: 200 });
    if (body.method === 'initialize') return json(init(body.id), { 'mcp-session-id': 'sess-1' });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 't' }] } });
    if (body.method === 'tools/call')
      return sseResponse([
        { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
        { jsonrpc: '2.0', id: 999, method: 'ping' },
        { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } },
      ]);
    if (body.id === 999) return new Response(null, { status: 202 });
    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } });
  });
  const seen = [];
  const c = new McpHttpClient({ url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer s' }, fetch, onNotification: (m) => seen.push(m) });
  assert.deepEqual(await c.request('tools/list', undefined), { tools: [{ name: 't' }] });
  assert.equal(calls[0].body.params.protocolVersion, '2025-06-18');
  assert.equal(calls[0].headers.Authorization, 'Bearer s');
  assert.equal(calls[2].headers['Mcp-Session-Id'], 'sess-1');
  assert.equal(calls[2].headers['MCP-Protocol-Version'], '2025-06-18');
  assert.equal(c.toolsEpoch, 0);
  assert.deepEqual(await c.request('tools/call', { name: 't' }), { content: [{ type: 'text', text: 'ok' }] });
  assert.equal(c.toolsEpoch, 1);
  assert.deepEqual(seen, ['notifications/tools/list_changed']);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.some((x) => x.body?.id === 999 && x.body.result), 'the server ping got an answer');
  await assert.rejects(c.request('nope', {}), /MCP error -32601: no/);
  await c.close();
  assert.equal(calls.at(-1).method, 'DELETE');
});

test('HTTP client: expired session re-initializes once; HTTP errors and timeouts are reported', async () => {
  let sessions = 0;
  const { fetch } = fakeHttp((body, initArg) => {
    if (body.method === 'initialize') return json(init(body.id), { 'mcp-session-id': `s${++sessions}` });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return initArg.headers['Mcp-Session-Id'] === 's1' ? new Response('gone', { status: 404 }) : json({ jsonrpc: '2.0', id: body.id, result: { tools: [] } });
    if (body.method === 'slow') return new Promise((_, reject) => initArg.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
    return new Response('denied', { status: 401 });
  });
  const c = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch });
  assert.deepEqual(await c.request('tools/list', undefined), { tools: [] });
  assert.equal(sessions, 2);
  await assert.rejects(c.request('other', {}), /HTTP 401 \(check the authorization headers\): denied/);
  await assert.rejects(c.request('slow', {}, 50), /timed out/);
});

test('HTTP client: oversized JSON bodies are refused', async () => {
  const { fetch } = fakeHttp((body) => {
    if (body.method === 'initialize') return json(init(body.id));
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return new Response(new ReadableStream({
      start(c) {
        const chunk = new Uint8Array(1024 * 1024).fill(32);
        for (let i = 0; i < 17; i++) c.enqueue(chunk);
        c.close();
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const c = new McpHttpClient({ url: 'https://x.dev/mcp', headers: {}, fetch });
  await assert.rejects(c.request('tools/list', undefined), /exceeded 16 MB/);
});
test('MCP project and working-directory validation accepts absolute Windows paths and rejects relative paths', () => {
  const base = { id: 'windows', name: 'windows', enabled: true, scope: 'project', transport: 'stdio', command: 'node', args: [], env: [] };
  for (const path of ['/work/project', 'C:\\work\\project', 'C:/work/project', '\\\\server\\share\\project']) {
    assert.deepEqual(cfg.validateServer({ ...base, project: path, cwd: path }), []);
  }
  for (const path of ['relative', 'C:relative', 'C:\\work\0bad']) {
    const errors = cfg.validateServer({ ...base, project: path, cwd: path });
    assert.ok(errors.includes('project')); assert.ok(errors.includes('cwd'));
  }
});
