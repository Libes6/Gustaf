// The ACP client (providers/acp/*) against a synthetic agent: JSON-RPC plumbing, initialize / authenticate / session
// calls, permission requests, the fs confinement, unsupported terminal methods and hostile input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeAgent } from './helpers/fakeAcp.mjs';

register('./helpers/hooks.mjs', import.meta.url);
const { createAcpClient, parseConfigOptions, parseInitialize } = await import('../src/providers/acp/client.ts');
const { AcpError, classify, createConnection, scrub } = await import('../src/providers/acp/rpc.ts');
const { confineToRoot } = await import('../src/providers/acp/fsPolicy.ts');
const { createUpdateMapper, planText } = await import('../src/providers/acp/updates.ts');

const client = (agent, o = {}) =>
  createAcpClient({
    duplex: agent,
    permission: async () => ({ outcome: 'cancelled' }),
    onUpdate: () => {},
    ...o,
  });

test('initialize sends the client capabilities and parses the agent answer', async () => {
  const agent = fakeAgent();
  const init = await client(agent).initialize();
  const sent = agent.calls('initialize')[0].params;
  assert.equal(sent.protocolVersion, 1);
  assert.deepEqual(sent.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(init.agentInfo.version, '1.3.0');
  assert.deepEqual(
    init.authMethods.map((m) => m.id),
    ['oauth-personal'],
  );
  assert.equal(init.capabilities.resume, true);
  assert.equal(init.capabilities.image, true);
  assert.equal(init.capabilities.loadSession, false);
});

test('fs capabilities are advertised only when a host is injected', async () => {
  const agent = fakeAgent();
  await client(agent, { fs: { root: '/work', read: async () => '', write: async () => {} } }).initialize();
  assert.deepEqual(agent.calls('initialize')[0].params.clientCapabilities.fs, {
    readTextFile: true,
    writeTextFile: true,
  });
});

test('a JSON-RPC error becomes a typed AcpError with code and method', async () => {
  const agent = fakeAgent({
    onRequest: (m, r) =>
      m.method === 'authenticate' ? (r.fail(-32000, 'Authentication required'), 'handled') : undefined,
  });
  const c = client(agent);
  await c.initialize();
  await assert.rejects(
    c.authenticate('oauth-personal'),
    (e) => e instanceof AcpError && e.kind === 'rpc' && e.code === -32000 && e.method === 'authenticate',
  );
});

test('a request that gets no answer times out; a late answer is ignored', async () => {
  const agent = fakeAgent({ onRequest: (m) => (m.method === 'session/new' ? 'silent' : undefined) });
  const c = client(agent, { requestTimeoutMs: 30 });
  await c.initialize();
  await assert.rejects(c.newSession('/w'), (e) => e.kind === 'timeout');
  agent.emit({ jsonrpc: '2.0', id: 2, result: { sessionId: 'late' } }); // must not throw
  await sleep(5);
});

test('an abort signal rejects an authenticate that waits for the user', async () => {
  const agent = fakeAgent({ onRequest: (m) => (m.method === 'authenticate' ? 'silent' : undefined) });
  const c = client(agent);
  await c.initialize();
  const ac = new AbortController();
  const p = c.authenticate('oauth-personal', { signal: ac.signal, timeoutMs: 60000 });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => e.kind === 'aborted');
});

test('process exit fails every pending request and later ones', async () => {
  const agent = fakeAgent({ onRequest: (m) => (m.method === 'session/new' ? 'silent' : undefined) });
  agent.err = 'boom: crashed with key sk-secret-123';
  const c = client(agent, { redact: () => ['sk-secret-123'] });
  await c.initialize();
  const p = c.newSession('/w');
  setTimeout(() => agent.exit(3), 5);
  await assert.rejects(
    p,
    (e) => e.kind === 'closed' && /exit 3/.test(e.message) && !e.message.includes('sk-secret-123'),
  );
  await assert.rejects(c.newSession('/w'), (e) => e.kind === 'closed');
});

test('malformed and unknown messages never throw', async () => {
  const agent = fakeAgent();
  const updates = [];
  const c = client(agent, { onUpdate: (s, u) => updates.push([s, u.sessionUpdate]) });
  await c.initialize();
  for (const junk of [
    null,
    5,
    'text',
    [],
    {},
    { jsonrpc: '1.0', method: 'x' },
    { id: {}, result: 1 },
    { method: 'session/update' },
    { method: 'session/update', params: { sessionId: 3 } },
    { method: 'session/update', params: { sessionId: 's', update: 'x' } },
    { method: 'weird/notification', params: {} },
  ])
    agent.emit(junk);
  agent.update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
  await sleep(10);
  assert.deepEqual(updates, [['s1', 'agent_message_chunk']]);
  assert.equal(classify({ jsonrpc: '2.0', id: 1, result: null }).kind, 'response');
  assert.equal(classify({ jsonrpc: '2.0', id: null, method: 'm' }).kind, 'notification');
});

test('terminal methods and unknown requests are answered with method not found', async () => {
  const agent = fakeAgent();
  const c = client(agent);
  await c.initialize();
  const r = await agent.request('terminal/create', { sessionId: 's', command: 'ls' });
  assert.equal(r.error.code, -32601);
  const r2 = await agent.request('fs/read_text_file', { sessionId: 's', path: '/etc/passwd' });
  assert.equal(r2.error.code, -32601); // no host injected
  const r3 = await agent.request('mystery/method', {});
  assert.equal(r3.error.code, -32601);
});

test('permission requests: only an offered option can be selected; failures and bad shapes cancel', async () => {
  const agent = fakeAgent();
  let answer = { outcome: 'selected', optionId: 'allow' };
  const seen = [];
  const c = client(agent, {
    permission: async (req) => (seen.push(req), answer),
  });
  await c.initialize();
  const params = {
    sessionId: 's1',
    toolCall: {
      toolCallId: 't1',
      title: 'Run ls',
      kind: 'execute',
      content: [{ type: 'content', content: { type: 'text', text: 'ls -la' } }],
    },
    options: [
      { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  };
  assert.deepEqual((await agent.request('session/request_permission', params)).result, {
    outcome: { outcome: 'selected', optionId: 'allow' },
  });
  assert.equal(seen[0].title, 'Run ls');
  assert.equal(seen[0].detail, 'ls -la');
  answer = { outcome: 'selected', optionId: 'not-offered' };
  assert.deepEqual((await agent.request('session/request_permission', params)).result, {
    outcome: { outcome: 'cancelled' },
  });
  const bad = await agent.request('session/request_permission', { sessionId: 's1' });
  assert.equal(bad.error.code, -32602);
});

test('fs requests are confined to the project root', async () => {
  const agent = fakeAgent();
  const files = new Map([['src/a.txt', 'hello']]);
  const written = [];
  const c = client(agent, {
    fs: {
      root: '/work/proj',
      read: async (rel) => files.get(rel) ?? '',
      write: async (rel, content) => void written.push([rel, content]),
    },
  });
  await c.initialize();
  const ok = await agent.request('fs/read_text_file', { sessionId: 's', path: '/work/proj/src/a.txt' });
  assert.deepEqual(ok.result, { content: 'hello' });
  for (const path of [
    '/work/proj/../secret',
    '/work/other/x',
    '../x',
    'src/a.txt',
    '/work/proj-evil/x',
    '/work/proj/a\0b',
    5,
  ]) {
    const r = await agent.request('fs/read_text_file', { sessionId: 's', path });
    assert.equal(r.error?.code, -32602, String(path));
  }
  const w = await agent.request('fs/write_text_file', { sessionId: 's', path: '/work/proj/out/b.txt', content: 'x' });
  assert.equal(w.result, null);
  assert.deepEqual(written, [['out/b.txt', 'x']]);
  const badWrite = await agent.request('fs/write_text_file', { sessionId: 's', path: '/work/proj/b', content: 7 });
  assert.equal(badWrite.error.code, -32602);
  assert.equal(confineToRoot('/work/proj', '/work/proj/./x/../y'), 'y');
  assert.equal(confineToRoot('C:\\w\\p', 'c:\\w\\p\\a\\b.txt'), 'a/b.txt');
  assert.throws(() => confineToRoot('C:\\w\\p', 'C:\\w\\q\\a'));
});

test('session calls parse config options (flat and grouped) and the legacy models block', async () => {
  const agent = fakeAgent({
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          {
            group: 'g',
            name: 'G',
            options: [
              { value: 'a', name: 'A' },
              { value: 'b', name: 'B' },
            ],
          },
        ],
      },
      { id: 'flag', type: 'boolean', currentValue: true },
    ],
  });
  const c = client(agent);
  await c.initialize();
  const s = await c.newSession('/w');
  assert.equal(s.sessionId, 's1');
  assert.deepEqual(
    s.configOptions.map((o) => [o.id, o.options.map((x) => x.value)]),
    [['model', ['a', 'b']]],
  );
  assert.deepEqual(agent.calls('session/new')[0].params, { cwd: '/w', mcpServers: [] });
  assert.deepEqual(parseConfigOptions('nope'), []);
  assert.equal(parseInitialize({}).capabilities.logout, false);
  assert.throws(() => parseInitialize(null));
});

test('prompt returns the stop reason and usage; unknown stop reasons read as end_turn', async () => {
  const agent = fakeAgent({
    onPrompt: () => ({ stopReason: 'weird', usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 2 } }),
  });
  const c = client(agent);
  await c.initialize();
  const r = await c.prompt('s1', [{ type: 'text', text: 'hi' }]);
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.usage.inputTokens, 10);
  assert.equal(r.usage.cachedReadTokens, 2);
});

test('cancel is a notification', async () => {
  const agent = fakeAgent();
  const c = client(agent);
  await c.cancel('s1');
  const m = agent.written.at(-1);
  assert.equal(m.method, 'session/cancel');
  assert.equal(m.id, undefined);
});

test('connection scrub removes secrets from messages', () => {
  assert.equal(scrub('key=abcd1234 end', ['abcd1234']), 'key=*** end');
  assert.equal(scrub('x', ['ab']), 'x'); // too short to be a real secret
  const conn = createConnection(fakeAgent(), { onRequest: async () => null, onNotification: () => {} });
  assert.equal(conn.pendingCount(), 0);
});

test('update mapper: text, tool calls merged by id, plan, thoughts, unknown kinds', () => {
  const m = createUpdateMapper();
  assert.deepEqual(m.map({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } }), [
    { type: 'text', text: 'Hi' },
  ]);
  assert.deepEqual(m.map({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AAAA' } }), []);
  assert.equal(
    m.map({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })[0].type,
    'thought',
  );
  const first = m.map({
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'Run tests',
    kind: 'execute',
    status: 'pending',
    rawInput: { CommandLine: 'npm test' },
  })[0];
  assert.deepEqual(first.card, {
    id: 'acp:c1',
    name: 'shell',
    args: { command: 'npm test' },
    status: 'running',
    output: undefined,
  });
  const done = m.map({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'ok 3 tests' } }],
  })[0];
  assert.equal(done.card.status, 'success');
  assert.equal(done.card.args.command, 'npm test'); // kept from the announcing call
  assert.equal(done.card.output, 'ok 3 tests');
  const edit = m.map({
    sessionUpdate: 'tool_call',
    toolCallId: 'c2',
    title: 'Edit a.ts',
    kind: 'edit',
    status: 'in_progress',
    locations: [{ path: '/w/a.ts', line: 3 }],
    content: [{ type: 'diff', path: '/w/a.ts', oldText: 'a', newText: 'b\nc' }],
  })[0];
  assert.equal(edit.card.name, 'edit');
  assert.equal(edit.card.args.path, '/w/a.ts');
  assert.match(edit.card.output, /edited \(\+2 -1 lines\)/);
  assert.deepEqual(
    m.openCalls().map((c) => c.id),
    ['acp:c2'],
  );
  const plan = m.map({
    sessionUpdate: 'plan',
    entries: [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'in_progress' },
      { nope: 1 },
      { content: 'three', status: 'bogus' },
    ],
  })[0];
  assert.equal(planText(plan.entries), '[x] one\n[~] two\n[ ] three');
  for (const junk of [
    null,
    'x',
    {},
    { sessionUpdate: 'future_kind' },
    { sessionUpdate: 'tool_call' },
    { sessionUpdate: 'tool_call', toolCallId: 5 },
    { sessionUpdate: 'plan', entries: 'x' },
  ])
    assert.deepEqual(m.map(junk), []);
  const huge = m.map({
    sessionUpdate: 'tool_call',
    toolCallId: 'c3',
    title: 'x'.repeat(5000),
    kind: 'other',
    rawOutput: 'y'.repeat(50000),
  })[0].card;
  assert.ok(huge.name.length <= 200 && huge.output.length < 8100);
});
