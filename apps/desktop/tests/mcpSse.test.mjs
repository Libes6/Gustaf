// MCP legacy HTTP+SSE transport (2024-11-05): the client against a fake SSE server (GET stream + POST endpoint, no
// network), and the runtime's per-server transport choice (auto-detect, explicit streamable, explicit SSE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { McpSseClient } = await import('../src/agent/mcp/sse.ts');
const { McpHttpClient, isLegacySseHint, HttpStatusError } = await import('../src/agent/mcp/http.ts');
const { SseDecoder } = await import('../src/agent/mcp/protocol.ts');
const { SIGN_IN_NEEDED } = await import('../src/agent/mcp/oauth.ts');
const cfg = await import('../src/agent/mcp/config.ts');
const rt = await import('../src/agent/mcp/runtime.ts');

const URL_SSE = 'https://sse.example/sse';
const enc = new TextEncoder();

/**
 * A fake legacy server. `GET /sse` opens a stream and sends the `endpoint` event; `POST /messages?s=N` answers 202 and
 * puts the JSON-RPC answer on the stream of that session. `o.streamablePost` is the status the server gives a POST to
 * /sse itself (what a streamable-HTTP client sends first).
 */
function fakeServer(o = {}) {
  const log = { gets: [], posts: [], streams: [], sessionPosts: [], cancelled: [] };
  let sessions = 0;
  const streams = new Map();
  const send = (id, event, data) => streams.get(id)?.enqueue(enc.encode(`event: ${event}\ndata: ${data}\n\n`));
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname === '/sse' && init.method === 'GET') {
      log.gets.push({ headers: init.headers, signal: init.signal });
      if (o.getStatus) return new Response('nope', { status: o.getStatus, headers: o.getHeaders });
      if (o.getType) return new Response('<html>', { status: 200, headers: { 'content-type': o.getType } });
      const id = ++sessions;
      let ctl;
      const body = new ReadableStream({
        start(c) {
          ctl = c;
          streams.set(id, c);
          if (o.endpoint !== null) c.enqueue(enc.encode(`: keepalive\n\nevent: endpoint\ndata: ${o.endpoint ?? `/messages?s=${id}`}\n\n`.replace('{id}', id)));
        },
        cancel() {
          log.streams.push({ id, cancelled: true });
          streams.delete(id);
        },
      });
      init.signal?.addEventListener('abort', () => {
        try {
          ctl.error(new DOMException('Aborted', 'AbortError'));
        } catch {}
      });
      log.lastStream = { id, ctl };
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (u.pathname === '/sse' && init.method === 'POST') {
      log.posts.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return new Response('Method Not Allowed', { status: o.streamablePost ?? 405 });
    }
    if (u.pathname === '/messages' && init.method === 'POST') {
      const id = Number(u.searchParams.get('s'));
      const msg = JSON.parse(init.body);
      log.sessionPosts.push({ url, headers: init.headers, body: msg });
      if (o.postStatus && o.postStatus(msg, init.headers)) return new Response('', { status: o.postStatus(msg, init.headers) });
      if (msg.method === 'notifications/cancelled') log.cancelled.push(msg.params);
      if (msg.id === undefined) return new Response('Accepted', { status: 202 });
      const reply = (result, error) => send(id, 'message', JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }));
      if (msg.method === 'initialize') setTimeout(() => reply({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'legacy' } }), 0);
      else if (msg.method === 'tools/list') {
        if (o.notifyOnList) send(id, 'message', JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }));
        if (o.pingOnList) send(id, 'message', JSON.stringify({ jsonrpc: '2.0', id: 'srv1', method: 'ping' }));
        setTimeout(() => reply({ tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] }), 0);
      } else if (msg.method === 'slow') {
        /* never answered */
      } else if (msg.method === 'fail') setTimeout(() => reply(undefined, { code: -32000, message: 'boom' }), 0);
      else setTimeout(() => reply({ ok: true, method: msg.method }), 0);
      return new Response('Accepted', { status: 202 });
    }
    return new Response('', { status: 404 });
  };
  return { fetch, log, send, streams, endStream: () => log.lastStream.ctl.close(), sessions: () => sessions };
}
const mk = (srv, extra = {}) => new McpSseClient({ url: URL_SSE, headers: { 'X-Team': 'core' }, fetch: srv.fetch, ...extra });

test('SSE decoder exposes event names and keeps comments out', () => {
  const d = new SseDecoder();
  assert.deepEqual(d.pushEvents(': hi\n\nevent: endpoint\ndata: /m?s=1\n\ndata: {"a":1}\n\nevent: \ndata: x\n\n'), [
    { event: 'endpoint', data: '/m?s=1' },
    { event: 'message', data: '{"a":1}' },
    { event: 'message', data: 'x' },
  ]);
  assert.deepEqual(new SseDecoder().push('data: a\n\ndata: b\n'), ['a']);
});

test('SSE: GET stream, endpoint event, initialize and requests over POST with answers on the stream', async () => {
  const srv = fakeServer({ notifyOnList: true, pingOnList: true });
  const seen = [];
  const c = mk(srv, { onNotification: (m) => seen.push(m) });
  const info = await c.connect();
  assert.equal(info.protocolVersion, '2024-11-05');
  assert.equal(srv.log.gets.length, 1);
  assert.equal(srv.log.gets[0].headers.Accept, 'text/event-stream');
  assert.equal(srv.log.gets[0].headers['X-Team'], 'core');
  assert.deepEqual(srv.log.sessionPosts.map((p) => p.body.method), ['initialize', 'notifications/initialized']);
  const tools = await c.request('tools/list', undefined);
  assert.equal(tools.tools[0].name, 'echo');
  assert.equal(c.toolsEpoch, 1);
  assert.deepEqual(seen, ['notifications/tools/list_changed']);
  await new Promise((r) => setTimeout(r, 10));
  const pong = srv.log.sessionPosts.find((p) => p.body.id === 'srv1');
  assert.deepEqual(pong.body, { jsonrpc: '2.0', id: 'srv1', result: {} }, 'a server ping is answered through the POST endpoint');
  // The streamable-HTTP session headers are not used on this transport; POSTs go to the announced endpoint.
  for (const p of srv.log.sessionPosts) {
    assert.ok(!('Mcp-Session-Id' in p.headers) && !('MCP-Protocol-Version' in p.headers));
    assert.equal(p.headers['Content-Type'], 'application/json');
    assert.equal(p.url, 'https://sse.example/messages?s=1');
  }
  await assert.rejects(c.request('fail', {}), /MCP error -32000: boom/);
  // connect() is idempotent: one stream.
  await c.connect();
  assert.equal(srv.log.gets.length, 1);
  await c.close();
  assert.equal(srv.log.gets[0].signal.aborted, true, 'close() ends the stream');
});

test('SSE: the endpoint may be absolute on the same origin, never on another one; wrong content types and statuses are errors', async () => {
  const ok = fakeServer({ endpoint: 'https://sse.example/messages?s=1' });
  assert.equal((await mk(ok).connect()).serverInfo.name, 'legacy');
  for (const endpoint of ['https://evil.example/messages?s=1', 'http://sse.example/messages?s=1', 'https://u:p@sse.example/messages?s=1']) {
    const srv = fakeServer({ endpoint });
    await assert.rejects(mk(srv).connect(), /another origin/, endpoint);
    assert.equal(srv.log.sessionPosts.length, 0, 'nothing is POSTed to a foreign endpoint');
  }
  await assert.rejects(mk(fakeServer({ getType: 'text/html' })).connect(), /did not open an event stream/);
  await assert.rejects(mk(fakeServer({ getStatus: 404 })).connect(), (e) => e instanceof HttpStatusError && e.status === 404);
  await assert.rejects(mk(fakeServer({ getStatus: 500 })).connect(), /HTTP 500/);
});

test('SSE: a server that never sends its endpoint times out and the next call retries', async () => {
  const srv = fakeServer({ endpoint: null });
  const c = mk(srv);
  await assert.rejects(c.connect(50), /did not send its message endpoint within/);
  assert.equal(srv.log.gets[0].signal.aborted, true);
  await assert.rejects(c.connect(50), /did not send its message endpoint/);
  assert.equal(srv.log.gets.length, 2, 'a failed connect is retried');
});

test('SSE: timeouts and aborts return at once, send notifications/cancelled, and a late answer is never read', async () => {
  const srv = fakeServer();
  const c = mk(srv);
  await c.connect();
  await assert.rejects(c.request('slow', {}, 40), /timed out after/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.log.cancelled.length, 1);
  assert.equal(srv.log.cancelled[0].reason, 'timed out');
  const ctl = new AbortController();
  const p = c.request('slow', {}, 5000, ctl.signal);
  await new Promise((r) => setTimeout(r, 10));
  ctl.abort();
  await assert.rejects(p, (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(srv.log.cancelled.length, 2);
  assert.equal(srv.log.cancelled[1].reason, 'cancelled by the user');
  const slowIds = srv.log.sessionPosts.filter((p) => p.body.method === 'slow').map((p) => p.body.id);
  assert.deepEqual(srv.log.cancelled.map((x) => x.requestId), slowIds);
  // The server answers late: nothing breaks, the next request works.
  slowIds.forEach((id) => srv.send(1, 'message', JSON.stringify({ jsonrpc: '2.0', id, result: { late: true } })));
  assert.equal((await c.request('ping', {})).ok, true);
  // Already aborted: no request is sent at all.
  const before = srv.log.sessionPosts.length;
  const done = new AbortController();
  done.abort();
  await assert.rejects(c.request('ping', {}, 1000, done.signal), (e) => e.name === 'AbortError');
  assert.equal(srv.log.sessionPosts.length, before);
});

test('SSE: a dropped stream fails waiting requests, and the next request opens a new stream and initializes again', async () => {
  const srv = fakeServer();
  const c = mk(srv);
  await c.connect();
  const p = c.request('slow', {}, 5000);
  await new Promise((r) => setTimeout(r, 10));
  srv.endStream();
  await assert.rejects(p, /closed the event stream/);
  assert.equal((await c.request('ping', {})).ok, true);
  assert.equal(srv.log.gets.length, 2);
  assert.equal(srv.log.sessionPosts.filter((x) => x.body.method === 'initialize').length, 2);
});

test('SSE: OAuth hooks add the bearer to the stream and the POSTs, and refresh once after a 401', async () => {
  let token = 'old';
  let refreshes = 0;
  const srv = fakeServer({ postStatus: (msg, h) => (h.Authorization === 'Bearer old' ? 401 : 0) });
  const auth = { header: async () => `Bearer ${token}`, refresh: async () => (refreshes++, (token = 'new'), true) };
  const c = mk(srv, { auth, headers: { Authorization: 'Bearer configured' } });
  await c.connect();
  assert.equal(refreshes, 1);
  assert.equal(srv.log.gets[0].headers.Authorization, 'Bearer old');
  assert.deepEqual(srv.log.sessionPosts.map((p) => p.headers.Authorization).slice(0, 2), ['Bearer old', 'Bearer new']);
  // 401 on the GET, refresh, second GET.
  let t2 = 'bad';
  const srv2 = fakeServer();
  const inner = srv2.fetch;
  srv2.fetch = async (url, init) => (init.method === 'GET' && init.headers.Authorization === 'Bearer bad' ? new Response('', { status: 401 }) : inner(url, init));
  const c2 = new McpSseClient({ url: URL_SSE, headers: {}, fetch: srv2.fetch, auth: { header: async () => `Bearer ${t2}`, refresh: async () => ((t2 = 'good'), true) } });
  await c2.connect();
  assert.equal(srv2.log.gets.length, 1);
  assert.equal(srv2.log.gets[0].headers.Authorization, 'Bearer good');
  // A refusal to refresh is the sign-in message.
  const srv3 = fakeServer();
  const inner3 = srv3.fetch;
  srv3.fetch = async (url, init) => (init.method === 'GET' ? new Response('', { status: 401 }) : inner3(url, init));
  await assert.rejects(new McpSseClient({ url: URL_SSE, headers: {}, fetch: srv3.fetch, auth: { header: async () => 'Bearer x', refresh: async () => false } }).connect(), new RegExp(SIGN_IN_NEEDED));
});

// ---- the runtime's transport choice ----------------------------------------------------------------------------------

let seq = 0;
async function httpServer(fake, over = {}) {
  const id = `sse${++seq}`;
  const server = { ...cfg.blankServer(id, 'http'), name: `r${seq}`, url: URL_SSE, ...over };
  rt.setMcpFetch(fake.fetch);
  await rt.saveMcpServer(server);
  return (await rt.loadMcpConfig()).servers.find((s) => s.id === id);
}

test('config: the transport choice is validated, stored and imported', () => {
  const s = { ...cfg.blankServer('a', 'http'), name: 'r', url: 'https://x.dev/sse' };
  assert.deepEqual(cfg.validateServer(s), []);
  for (const t of ['auto', 'streamable', 'sse']) assert.deepEqual(cfg.validateServer({ ...s, httpTransport: t }), []);
  assert.deepEqual(cfg.validateServer({ ...s, httpTransport: 'websocket' }), ['transport']);
  assert.equal(cfg.normalizeConfig({ servers: [{ ...s, httpTransport: 'sse' }] }).servers[0].httpTransport, 'sse');
  assert.equal(cfg.normalizeConfig({ servers: [{ ...s, httpTransport: 'auto' }] }).servers[0].httpTransport, undefined, 'auto is the default and is not stored');
  assert.equal(cfg.normalizeConfig({ servers: [{ ...s, httpTransport: 'bogus' }] }).servers[0].httpTransport, undefined);
  const imp = cfg.parseImport(JSON.stringify({ a: { type: 'sse', url: 'https://x.dev/sse' }, b: { type: 'streamable-http', url: 'https://x.dev/mcp' }, c: { url: 'https://x.dev/m' }, d: { type: 'sse', command: 'x' } }), [], (() => { let i = 0; return () => `i${++i}`; })());
  assert.deepEqual(imp.servers.map((x) => x.httpTransport), ['sse', 'streamable', undefined]);
  assert.deepEqual(imp.errors, [{ name: 'd', code: 'url' }]);
});

test('runtime auto: a 4xx to the initialize POST falls back to SSE; 401, 403, 429 and 5xx do not', async () => {
  state.reset();
  for (const status of [400, 404, 405, 406, 415]) {
    const fake = fakeServer({ streamablePost: status });
    const s = await httpServer(fake);
    const r = await rt.testMcpServer(s);
    assert.equal(r.tools[0].name, 'echo', String(status));
    assert.equal(rt.mcpTransport(s.id), 'sse');
    assert.equal(fake.log.posts.length, 1, 'one streamable attempt first');
    assert.equal(fake.log.posts[0].body.method, 'initialize');
    assert.equal(fake.log.gets.length, 1);
    await rt.disconnectMcpServer(s.id);
  }
  for (const status of [401, 403, 408, 429, 500, 503]) {
    const fake = fakeServer({ streamablePost: status });
    const s = await httpServer(fake);
    await assert.rejects(rt.testMcpServer(s), new RegExp(`${status === 401 ? 'HTTP 401|sign-in' : `HTTP ${status}`}`), String(status));
    assert.equal(fake.log.gets.length, 0, `no SSE attempt after ${status}`);
    await rt.disconnectMcpServer(s.id);
  }
  assert.equal(isLegacySseHint(Object.assign(new HttpStatusError(404, 'x'), { initialize: true })), true);
  assert.equal(isLegacySseHint(new HttpStatusError(404, 'x')), false, 'only the initialize POST counts');
  assert.equal(isLegacySseHint(new Error('x')), false);
});

test('runtime explicit transport: sse skips the streamable attempt, streamable never tries SSE', async () => {
  state.reset();
  const fake = fakeServer();
  const s = await httpServer(fake, { httpTransport: 'sse' });
  assert.equal((await rt.testMcpServer(s)).tools.length, 1);
  assert.equal(fake.log.posts.length, 0, 'no POST to the stream URL');
  assert.equal(rt.mcpTransport(s.id), 'sse');
  const fake2 = fakeServer();
  const s2 = await httpServer(fake2, { httpTransport: 'streamable' });
  await assert.rejects(rt.testMcpServer(s2), /HTTP 405/);
  assert.equal(fake2.log.gets.length, 0);
  // A fallback that fails too reports both.
  const fake3 = fakeServer({ getStatus: 500 });
  const s3 = await httpServer(fake3);
  await assert.rejects(rt.testMcpServer(s3), /HTTP 500.*streamable HTTP failed first: HTTP 405/);
  // The failed detection is repeated on the next try (no half-connected state is kept).
  fake3.log.gets.length = 0;
  await assert.rejects(rt.testMcpServer(s3), /streamable HTTP failed first/);
  assert.equal(fake3.log.gets.length, 1);
  for (const x of [s, s2, s3]) await rt.disconnectMcpServer(x.id);
  rt.setMcpFetch(null);
});
