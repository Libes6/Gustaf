// Integration: the three API adapters (anthropic, openaiCompatible, openaiResponses) with their retry wiring, run
// against a scripted fetch. The adapters import Tauri's HTTP plugin, so they are bundled with esbuild and that
// import is replaced by a stub that delegates to `globalThis.__mcodeFetch`. Retry-After headers keep the real waits to a few ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: {
    contents: "export { anthropic } from './src/providers/anthropic.ts'; export { openaiCompatible } from './src/providers/openaiCompatible.ts'; export { openaiResponses } from './src/providers/openaiResponses.ts';",
    resolveDir: root, loader: 'ts',
  },
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
  plugins: [{
    name: 'tauri-stub',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\// }, (a) => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'js',
        contents: 'export const fetch = (...a) => globalThis.__mcodeFetch(...a); export const invoke = () => { throw new Error("no tauri"); };',
      }));
    },
  }],
});
const { anthropic, openaiCompatible, openaiResponses } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const enc = new TextEncoder();
const stream = (events, { failWith } = {}) => {
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < events.length) return c.enqueue(enc.encode(`data: ${JSON.stringify(events[i++])}\n\n`));
      if (failWith) c.error(failWith);
      else c.close();
    },
  });
};
const ok = (events, opts) => () => new Response(stream(events, opts), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const http = (status, message, headers = { 'retry-after-ms': '1' }) => () => new Response(JSON.stringify({ error: { message } }), { status, headers });

/** Installs a fetch that plays `steps` (the last repeats) and returns its call log. */
function mockFetch(...steps) {
  const calls = [];
  globalThis.__mcodeFetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const v = await step(init);
    if (v instanceof Error) throw v;
    return v;
  };
  return calls;
}

const providers = {
  anthropic: {
    make: () => anthropic({ id: 'p', kind: 'anthropic', name: 'A', baseUrl: 'https://api.test' }, 'k'),
    hello: (text = 'Hi') => [
      { type: 'message_start', message: { usage: { input_tokens: 3 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, 1) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(1) } },
      { type: 'message_delta', usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ],
    early: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    path: '/v1/messages',
    cut: 3, // events up to and including the first text delta
  },
  openaiCompatible: {
    make: () => openaiCompatible({ id: 'p', kind: 'openrouter', name: 'O', baseUrl: 'https://api.test/v1' }, 'k'),
    hello: (text = 'Hi') => [
      { choices: [{ delta: { content: text.slice(0, 1) } }] },
      { choices: [{ delta: { content: text.slice(1) } }] },
      { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ],
    early: { error: { code: 502, message: 'Upstream provider failed' } },
    path: '/chat/completions',
    cut: 2,
  },
  openaiResponses: {
    make: () => openaiResponses({ id: 'p', kind: 'openai', name: 'R', baseUrl: 'https://api.test/v1' }, 'k'),
    hello: (text = 'Hi') => [
      { type: 'response.output_text.delta', delta: text.slice(0, 1) },
      { type: 'response.output_text.delta', delta: text.slice(1) },
      { type: 'response.completed', response: { id: 'resp_1', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 3, output_tokens: 2 } } },
    ],
    early: { type: 'response.failed', response: { error: { code: 'server_error', message: 'The server had an error' } } },
    path: '/responses',
    cut: 2,
  },
};

function turnInput(over = {}) {
  const ctl = new AbortController();
  const texts = [];
  const retries = [];
  return {
    ctl, texts, retries,
    input: {
      system: 's', messages: [{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }], tools: [], model: 'm',
      signal: ctl.signal, onText: (d) => texts.push(d), onRetry: (i) => retries.push(i), ...over,
    },
  };
}
const textOf = (out) => out.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

for (const [name, p] of Object.entries(providers)) {
  test(`${name}: 429 with Retry-After is retried and the answer is delivered once`, async () => {
    const calls = mockFetch(http(429, 'Rate limited', { 'retry-after-ms': '5' }), ok(p.hello()));
    const t = turnInput();
    const out = await p.make().turn(t.input);
    assert.equal(textOf(out), 'Hi');
    assert.deepEqual(t.texts, ['H', 'i'], 'no duplicated text from the failed attempt');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith(p.path));
    assert.deepEqual(t.retries.map((r) => [r.attempt, r.kind, r.status, r.delayMs]), [[1, 'rate_limit', 429, 5]]);
  });

  test(`${name}: 5xx then success`, async () => {
    const calls = mockFetch(http(502, 'bad gateway'), http(503, 'busy'), ok(p.hello('Done')));
    const t = turnInput();
    const out = await p.make().turn(t.input);
    assert.equal(textOf(out), 'Done');
    assert.equal(calls.length, 3);
    assert.deepEqual(t.retries.map((r) => r.status), [502, 503]);
  });

  test(`${name}: a network error before the response is retried`, async () => {
    const calls = mockFetch(() => new TypeError('fetch failed'), ok(p.hello()));
    const t = turnInput();
    assert.equal(textOf(await p.make().turn(t.input)), 'Hi');
    assert.equal(calls.length, 2);
    assert.equal(t.retries[0].kind, 'network');
  });

  test(`${name}: 401 is not retried and reads as an authentication failure`, async () => {
    const calls = mockFetch(http(401, 'invalid x-api-key'), ok(p.hello()));
    const t = turnInput();
    await assert.rejects(p.make().turn(t.input), (e) => e.kind === 'auth' && /\b401\b/.test(e.message) && /invalid x-api-key/.test(e.message));
    assert.equal(calls.length, 1);
    assert.deepEqual(t.retries, []);
  });

  test(`${name}: an error event before any output is retried`, async () => {
    const calls = mockFetch(ok([p.early]), ok(p.hello()));
    const t = turnInput();
    assert.equal(textOf(await p.make().turn(t.input)), 'Hi');
    assert.equal(calls.length, 2);
    assert.equal(t.retries.length, 1);
    assert.equal(t.retries[0].kind, 'server');
  });

  test(`${name}: a connection that drops after partial output is NOT retried (the error is surfaced)`, async () => {
    const calls = mockFetch(ok(p.hello().slice(0, p.cut), { failWith: new TypeError('terminated') }), ok(p.hello()));
    const t = turnInput();
    await assert.rejects(p.make().turn(t.input), (e) => e.kind === 'network' && /terminated/.test(e.message) && e.retryable);
    assert.equal(calls.length, 1, 'no second request after text was shown');
    assert.ok(t.texts.length >= 1, 'some text reached onText before the failure');
    assert.deepEqual(t.retries, []);
  });

  test(`${name}: an error event after output is surfaced, not retried`, async () => {
    const calls = mockFetch(ok([...p.hello().slice(0, p.cut), p.early]), ok(p.hello()));
    const t = turnInput();
    await assert.rejects(p.make().turn(t.input), (e) => e.kind === 'server');
    assert.equal(calls.length, 1);
    assert.ok(t.texts.length >= 1);
  });

  test(`${name}: attempts are capped`, async () => {
    const calls = mockFetch(http(503, 'down'));
    const t = turnInput();
    await assert.rejects(p.make().turn(t.input), (e) => e.kind === 'server' && /Gave up after 4 attempts/.test(e.message));
    assert.equal(calls.length, 4);
    assert.equal(t.retries.length, 3);
  });

  test(`${name}: aborting during the backoff wait stops at once`, async () => {
    const calls = mockFetch(http(429, 'slow down', { 'retry-after': '25' }), ok(p.hello()));
    const t = turnInput();
    t.input.onRetry = () => setTimeout(() => t.ctl.abort(), 10);
    const started = Date.now();
    await assert.rejects(p.make().turn(t.input), (e) => e.name === 'AbortError');
    assert.ok(Date.now() - started < 2000);
    assert.equal(calls.length, 1);
  });

  test(`${name}: the request is sent with the abort signal and the same body on every attempt`, async () => {
    const calls = mockFetch(http(500, 'x'), ok(p.hello()));
    const t = turnInput();
    await p.make().turn(t.input);
    assert.equal(calls[0].init.signal, t.ctl.signal);
    assert.equal(calls[0].init.body, calls[1].init.body);
  });
}

test('anthropic: a stream that ends without message_stop is an error, not a truncated answer or tool call', async () => {
  const cut = [
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'write_file', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt","con' } },
  ];
  // Nothing was shown yet: retried, and the complete second answer wins.
  const calls = mockFetch(ok(cut), ok(providers.anthropic.hello()));
  const t = turnInput();
  const out = await providers.anthropic.make().turn(t.input);
  assert.equal(textOf(out), 'Hi');
  assert.equal(out.parts.some((p) => p.type === 'tool_call'), false);
  assert.equal(calls.length, 2);
  // Text was already shown: surfaced as a network error instead of a silent partial reply.
  mockFetch(ok(providers.anthropic.hello().slice(0, 3)));
  await assert.rejects(providers.anthropic.make().turn(turnInput().input), (e) => e.kind === 'network');
});

test('listModels uses the same error classification (no retry)', async () => {
  const calls = mockFetch(http(401, 'bad key'), ok([]));
  await assert.rejects(providers.anthropic.make().listModels(), (e) => e.kind === 'auth' && /401/.test(e.message));
  assert.equal(calls.length, 1);
  mockFetch(() => new Error('error sending request: Connection refused'));
  await assert.rejects(providers.openaiCompatible.make().listModels(), (e) => e.kind === 'network' && /server is running/.test(e.message));
});
