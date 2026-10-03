import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_POLICY, ProviderError, abortableSleep, backoffDelay, errorFromResponse, networkError, parseRetryAfter,
  requestWith, retryNoticeVars, streamError, withRetry,
} from '../src/providers/retry.ts';
import { sse } from '../src/providers/sse.ts';

// ---- helpers -----------------------------------------------------------------------------------------------------

/** Response factories, so a scripted step can repeat and still return a fresh body each time. */
const res = (status, body = '', headers = {}) => () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const errBody = (message) => ({ error: { message } });

/** A fetch that plays `steps` in order (the last one repeats). A step is a factory, an Error to throw, or an async fn. */
function scripted(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    const v = step instanceof Error ? step : await step(init);
    if (v instanceof Error) throw v;
    return v;
  };
  return { fetchImpl, calls };
}

/** Everything withRetry needs, with a recording sleep that returns instantly and no jitter. */
function rig(over = {}) {
  const sleeps = [];
  const retries = [];
  const texts = [];
  const ctl = new AbortController();
  const opts = {
    signal: ctl.signal,
    onText: (d) => texts.push(d),
    onRetry: (i) => retries.push(i),
    deps: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    ...over,
  };
  return { sleeps, retries, texts, ctl, opts };
}

const post = (fetchImpl, signal) => requestWith(fetchImpl, 'https://api.test/v1/x', { method: 'POST', signal });
const SSE_OK = res(200, 'data: {"ok":true}\n\n', { 'content-type': 'text/event-stream' });

/** Emits the events one per read, then fails (or closes). Erroring inside start() would discard the queued chunks. */
function sseStream(events, { failWith } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i < events.length) return c.enqueue(enc.encode(`data: ${JSON.stringify(events[i++])}\n\n`));
      if (failWith) c.error(failWith);
      else c.close();
    },
  });
}

// ---- Retry-After ---------------------------------------------------------------------------------------------------

test('Retry-After: delta-seconds, fractions, retry-after-ms, HTTP dates; garbage is ignored', () => {
  const h = (o) => new Headers(o);
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(parseRetryAfter(h({ 'retry-after': '5' }), now), 5000);
  assert.equal(parseRetryAfter(h({ 'retry-after': '1.5' }), now), 1500);
  assert.equal(parseRetryAfter(h({ 'retry-after': '0' }), now), 0);
  assert.equal(parseRetryAfter(h({ 'retry-after-ms': '250', 'retry-after': '9' }), now), 250);
  assert.equal(parseRetryAfter(h({ 'retry-after': 'Fri, 02 Oct 2026 12:00:30 GMT' }), now), 30_000);
  assert.equal(parseRetryAfter(h({ 'retry-after': 'Fri, 02 Oct 2026 11:59:00 GMT' }), now), 0, 'a date in the past means now');
  for (const bad of ['soon', '-3', '', '1e3']) assert.equal(parseRetryAfter(h({ 'retry-after': bad }), now), undefined, bad);
  assert.equal(parseRetryAfter(h({}), now), undefined);
  assert.equal(parseRetryAfter(undefined, now), undefined);
});

// ---- Classification ------------------------------------------------------------------------------------------------

test('HTTP statuses are classified: rate limit, auth, server, quota, plain request errors', async () => {
  const cases = [
    [429, 'rate_limit', true], [401, 'auth', false], [403, 'auth', false], [402, 'quota', false],
    [500, 'server', true], [502, 'server', true], [503, 'server', true], [504, 'server', true], [529, 'server', true], [408, 'server', true],
    [501, 'server', false], [505, 'server', false],
    [400, 'request', false], [404, 'request', false], [422, 'request', false],
  ];
  for (const [status, kind, retryable] of cases) {
    const e = await errorFromResponse(res(status, errBody('boom'))());
    assert.ok(e instanceof ProviderError && e instanceof Error);
    assert.equal(e.kind, kind, `${status} kind`);
    assert.equal(e.retryable, retryable, `${status} retryable`);
    assert.equal(e.status, status);
    assert.match(e.message, new RegExp(`\\(HTTP ${status}\\)`), 'status stays in the message');
    assert.match(e.message, /boom/, 'provider message is kept');
  }
});

test('messages are user-facing and keep what the 401 sign-in detection looks for', async () => {
  const auth = await errorFromResponse(res(401, errBody('invalid x-api-key'))());
  assert.match(auth.message, /Authentication failed \(HTTP 401\): invalid x-api-key\./);
  assert.match(auth.message, /Invalid API key/i);
  const limited = await errorFromResponse(res(429, errBody('Slow down'), { 'retry-after': '20' })());
  assert.equal(limited.retryAfterMs, 20_000);
  assert.match(limited.message, /^Rate limit reached \(HTTP 429\): Slow down\. Try again in about 20s\.$/);
  assert.match((await errorFromResponse(res(429, '', { 'retry-after': '300' })())).message, /about 5 min/);
  assert.match((await errorFromResponse(res(529, errBody('Overloaded'))())).message, /^Provider is overloaded \(HTTP 529\): Overloaded\./);
  assert.match((await errorFromResponse(res(503, '')())).message, /^Provider server error \(HTTP 503\)\./);
  assert.match((await errorFromResponse(res(403, errBody('no')) ())).message, /Access denied \(HTTP 403\)/);
});

test('quota and credit exhaustion is not a retryable rate limit', async () => {
  const openai = await errorFromResponse(res(429, { error: { message: 'You exceeded your current quota, please check your plan', code: 'insufficient_quota' } })());
  assert.equal(openai.kind, 'quota');
  assert.equal(openai.retryable, false);
  const anthropic = await errorFromResponse(res(400, errBody('Your credit balance is too low to access the Anthropic API.'))());
  assert.equal(anthropic.kind, 'quota');
  assert.equal((await errorFromResponse(res(402, errBody('Insufficient credits'))())).kind, 'quota');
  assert.equal((await errorFromResponse(res(400, errBody('max_tokens too large'))())).kind, 'request');
});

test('error bodies: string errors, plain text, HTML gateway pages and huge bodies', async () => {
  assert.match((await errorFromResponse(res(404, { error: 'model not found' })())).message, /model not found/);
  assert.match((await errorFromResponse(res(500, { message: 'top-level message' })())).message, /top-level message/);
  assert.match((await errorFromResponse(res(500, 'plain text failure')())).message, /plain text failure/);
  const html = await errorFromResponse(res(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')());
  assert.doesNotMatch(html.message, /<h1>/);
  assert.match(html.message, /HTTP 502/);
  const big = await errorFromResponse(res(500, 'x'.repeat(5000))());
  assert.ok(big.message.length < 700);
});

test('network failures are classified; a refused connection is not retried', () => {
  const e = networkError(new TypeError('fetch failed'));
  assert.equal(e.kind, 'network');
  assert.equal(e.retryable, true);
  assert.match(e.message, /^Network error: fetch failed\./);
  assert.equal(networkError('error sending request for url (https://api.test)').retryable, true, 'Tauri rejects with strings');
  const refused = networkError(new Error('error sending request: Connection refused (os error 61)'));
  assert.equal(refused.retryable, false);
  assert.match(refused.message, /server is running/);
  assert.equal(networkError(undefined).kind, 'network');
});

test('error events inside a stream are classified by type, code and status', () => {
  const kind = (info) => streamError(info).kind;
  assert.equal(kind({ type: 'overloaded_error', message: 'Overloaded' }), 'server');
  assert.equal(streamError({ type: 'overloaded_error' }).retryable, true);
  assert.equal(kind({ type: 'api_error' }), 'server');
  assert.equal(kind({ type: 'rate_limit_error' }), 'rate_limit');
  assert.equal(kind({ code: 'rate_limit_exceeded' }), 'rate_limit');
  assert.equal(kind({ code: 'server_error' }), 'server');
  assert.equal(kind({ type: 'authentication_error' }), 'auth');
  assert.equal(streamError({ type: 'authentication_error' }).retryable, false);
  assert.equal(kind({ code: 'insufficient_quota' }), 'quota');
  assert.equal(kind({ code: 502, message: 'upstream failed' }), 'server');
  assert.equal(kind({ code: '429', message: 'slow down' }), 'rate_limit');
  assert.equal(kind({ code: 401 }), 'auth');
  assert.equal(kind({ type: 'invalid_request_error', message: 'bad' }), 'request');
  assert.equal(streamError('plain string error').message, 'Request failed: plain string error.');
  assert.match(streamError(undefined).message, /stream error/);
});

// ---- Backoff -------------------------------------------------------------------------------------------------------

test('backoff doubles, is capped, and jitter stays inside [step * (1 - jitter), step]', () => {
  const p = { ...DEFAULT_POLICY, baseDelayMs: 1000, maxDelayMs: 5000, jitter: 0.5 };
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffDelay(n, p, () => 0)), [1000, 2000, 4000, 5000, 5000]);
  assert.deepEqual([1, 2, 3].map((n) => backoffDelay(n, p, () => 0.999999)), [500, 1000, 2000]);
  assert.equal(backoffDelay(2, { ...p, jitter: 1 }, () => 0.999999), 0, 'full jitter can reach zero');
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(3, p, Math.random);
    assert.ok(d >= 2000 && d <= 4000, String(d));
  }
  assert.equal(backoffDelay(2, { ...p, jitter: 0 }, () => 0.7), 2000, 'no jitter is deterministic');
});

// ---- withRetry -----------------------------------------------------------------------------------------------------

test('429 with Retry-After: waits exactly the advertised time, then succeeds', async () => {
  const { fetchImpl, calls } = scripted(res(429, errBody('Rate limited'), { 'retry-after': '3' }), SSE_OK);
  const r = rig();
  const out = await withRetry(async () => (await post(fetchImpl, r.ctl.signal)).status, r.opts);
  assert.equal(out, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(r.sleeps, [3000]);
  assert.equal(r.retries.length, 1);
  assert.deepEqual({ ...r.retries[0], message: undefined }, { attempt: 1, maxAttempts: 4, delayMs: 3000, kind: 'rate_limit', status: 429, message: undefined });
  assert.match(r.retries[0].message, /Rate limit reached/);
});

test('Retry-After beats the computed backoff, even a longer one', async () => {
  const { fetchImpl } = scripted(res(503, '', { 'retry-after-ms': '12000' }), SSE_OK);
  const r = rig();
  await withRetry(() => post(fetchImpl, r.ctl.signal), r.opts);
  assert.deepEqual(r.sleeps, [12_000]);
});

test('5xx then success: exponential backoff between attempts', async () => {
  const { fetchImpl, calls } = scripted(res(500, errBody('oops')), res(503, errBody('busy')), res(529, errBody('Overloaded')), SSE_OK);
  const r = rig();
  const out = await withRetry(async () => (await post(fetchImpl, r.ctl.signal)).status, r.opts);
  assert.equal(out, 200);
  assert.equal(calls.length, 4);
  assert.deepEqual(r.sleeps, [1000, 2000, 4000]);
  assert.deepEqual(r.retries.map((i) => [i.attempt, i.kind, i.status]), [[1, 'server', 500], [2, 'server', 503], [3, 'server', 529]]);
});

test('network errors before any response are retried', async () => {
  const calls = [];
  const flaky = async () => {
    calls.push(calls.length);
    if (calls.length === 1) throw new TypeError('fetch failed');
    if (calls.length === 2) throw 'error sending request for url'; // Tauri's fetch rejects with plain strings
    return SSE_OK();
  };
  const r = rig();
  const out = await withRetry(async () => (await post(flaky, r.ctl.signal)).status, r.opts);
  assert.equal(out, 200);
  assert.equal(calls.length, 3);
  assert.deepEqual(r.retries.map((i) => i.kind), ['network', 'network']);
});

test('401 and other client errors are never retried', async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const { fetchImpl, calls } = scripted(res(status, errBody('nope')), SSE_OK);
    const r = rig();
    await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts), (e) => e instanceof ProviderError && e.status === status && e.attempts === 1);
    assert.equal(calls.length, 1, `${status} must not be retried`);
    assert.deepEqual(r.sleeps, []);
    assert.deepEqual(r.retries, []);
  }
});

test('quota exhaustion on a 429 is not retried', async () => {
  const { fetchImpl, calls } = scripted(res(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }), SSE_OK);
  const r = rig();
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts), (e) => e.kind === 'quota');
  assert.equal(calls.length, 1);
});

test('a refused connection is not retried', async () => {
  const { fetchImpl, calls } = scripted(new Error('error sending request: Connection refused'), SSE_OK);
  const r = rig();
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts), (e) => e.kind === 'network' && /server is running/.test(e.message));
  assert.equal(calls.length, 1);
});

test('attempt cap: gives up after maxAttempts and says so', async () => {
  const { fetchImpl, calls } = scripted(res(503, errBody('still down')));
  const r = rig();
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, 'server');
    assert.equal(e.attempts, 4);
    assert.match(e.message, /still down/);
    assert.match(e.message, /Gave up after 4 attempts\.$/);
    return true;
  });
  assert.equal(calls.length, DEFAULT_POLICY.maxAttempts);
  assert.equal(r.sleeps.length, DEFAULT_POLICY.maxAttempts - 1);

  const custom = scripted(res(500));
  const r2 = rig({ policy: { maxAttempts: 2 } });
  await assert.rejects(withRetry(() => post(custom.fetchImpl, r2.ctl.signal), r2.opts));
  assert.equal(custom.calls.length, 2);
  const once = scripted(res(500));
  const r3 = rig({ policy: { maxAttempts: 1 } });
  await assert.rejects(withRetry(() => post(once.fetchImpl, r3.ctl.signal), r3.opts), (e) => !/Gave up/.test(e.message));
  assert.equal(once.calls.length, 1);
});

test('total wait cap: a Retry-After that does not fit is surfaced at once, with the advice', async () => {
  const { fetchImpl, calls } = scripted(res(429, errBody('Quota per minute'), { 'retry-after': '120' }), SSE_OK);
  const r = rig();
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts), (e) => {
    assert.equal(e.kind, 'rate_limit');
    assert.match(e.message, /Try again in about 2 min/);
    assert.doesNotMatch(e.message, /Gave up/, 'no retry was attempted');
    return true;
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(r.sleeps, []);
});

test('total wait cap: the sum of waits never exceeds maxTotalWaitMs', async () => {
  const { fetchImpl, calls } = scripted(res(503, '', { 'retry-after': '4' }));
  const r = rig({ policy: { maxAttempts: 10, maxTotalWaitMs: 10_000 } });
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts));
  assert.deepEqual(r.sleeps, [4000, 4000], 'a third 4s wait would reach 12s and is refused');
  assert.equal(calls.length, 3);
  assert.ok(r.sleeps.reduce((a, b) => a + b, 0) <= 10_000);
});

test('total wait cap: computed backoff is clamped to what is left of the budget', async () => {
  const { fetchImpl, calls } = scripted(res(503));
  const r = rig({ policy: { maxAttempts: 10, baseDelayMs: 4000, maxTotalWaitMs: 10_000 } });
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts));
  assert.deepEqual(r.sleeps, [4000, 6000], 'the second step (8 s) is cut to the 6 s left; with nothing left there is no third wait');
  assert.equal(calls.length, 3);
});

test('never retries after partial output reached onText, whatever the error', async () => {
  for (const make of [
    () => makeServerError(),
    () => networkError(new TypeError('terminated')),
    () => streamError({ type: 'rate_limit_error' }),
  ]) {
    const r = rig();
    let runs = 0;
    await assert.rejects(
      withRetry(async (onText) => {
        runs++;
        onText('Hello');
        throw make();
      }, r.opts),
      (e) => e instanceof ProviderError && e.retryable,
    );
    assert.equal(runs, 1);
    assert.deepEqual(r.texts, ['Hello']);
    assert.deepEqual(r.sleeps, []);
    assert.deepEqual(r.retries, []);
  }
});

function makeServerError() {
  return streamError({ type: 'overloaded_error', message: 'Overloaded' });
}

test('a failure before the first token is retried; one after it is not (and earlier text is not duplicated)', async () => {
  const r = rig();
  let runs = 0;
  await assert.rejects(
    withRetry(async (onText) => {
      runs++;
      if (runs === 1) throw makeServerError();
      onText('par');
      throw networkError(new TypeError('terminated'));
    }, r.opts),
    (e) => e.kind === 'network',
  );
  assert.equal(runs, 2);
  assert.deepEqual(r.texts, ['par']);
  assert.equal(r.retries.length, 1);
});

test('text delivered through the wrapped onText is forwarded unchanged', async () => {
  const r = rig();
  const out = await withRetry(async (onText) => {
    onText('a');
    onText('b');
    return 'done';
  }, r.opts);
  assert.equal(out, 'done');
  assert.deepEqual(r.texts, ['a', 'b']);
});

test('errors that are not classified provider errors pass through untouched and are not retried', async () => {
  const r = rig();
  const bug = new TypeError("Cannot read properties of undefined (reading 'text')");
  let runs = 0;
  await assert.rejects(withRetry(async () => { runs++; throw bug; }, r.opts), (e) => e === bug);
  assert.equal(runs, 1);
});

test('a throwing onRetry callback does not break the retry', async () => {
  const { fetchImpl } = scripted(res(503), SSE_OK);
  const r = rig({ onRetry: () => { throw new Error('ui bug'); } });
  assert.equal(await withRetry(async () => (await post(fetchImpl, r.ctl.signal)).status, r.opts), 200);
});

// ---- Aborting ------------------------------------------------------------------------------------------------------

test('abort during the backoff sleep rejects promptly with AbortError and makes no further request', async () => {
  const { fetchImpl, calls } = scripted(res(429, errBody('wait'), { 'retry-after': '25' }), SSE_OK);
  const ctl = new AbortController();
  const retries = [];
  const started = Date.now();
  const p = withRetry(() => post(fetchImpl, ctl.signal), {
    signal: ctl.signal,
    onText: () => {},
    onRetry: (i) => { retries.push(i); setTimeout(() => ctl.abort(), 20); },
    // default (real) sleep: a 25 s wait must be cut short
  });
  await assert.rejects(p, (e) => e.name === 'AbortError');
  assert.ok(Date.now() - started < 2000, 'did not wait out the 25 s Retry-After');
  assert.equal(retries.length, 1);
  assert.equal(calls.length, 1);
});

test('abortableSleep: resolves after the delay, rejects at once on abort, and cleans up its listener', async () => {
  const ctl = new AbortController();
  await abortableSleep(5, ctl.signal);
  const pending = abortableSleep(60_000, ctl.signal);
  ctl.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  await assert.rejects(abortableSleep(1, ctl.signal), (e) => e.name === 'AbortError', 'already aborted');
});

test('abort before the first attempt: nothing is sent', async () => {
  const { fetchImpl, calls } = scripted(SSE_OK);
  const r = rig();
  r.ctl.abort();
  await assert.rejects(withRetry(() => post(fetchImpl, r.ctl.signal), r.opts), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 0);
});

test('abort while the request is in flight is rethrown as is, not classified or retried', async () => {
  const r = rig();
  const inflight = async (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    setTimeout(() => r.ctl.abort(), 5);
  });
  let calls = 0;
  const counted = (...a) => { calls++; return inflight(...a); };
  await assert.rejects(withRetry(() => post(counted, r.ctl.signal), r.opts), (e) => e.name === 'AbortError' && !(e instanceof ProviderError));
  assert.equal(calls, 1);
  assert.deepEqual(r.sleeps, []);
});

test('abort that surfaces as a transport error (not an AbortError) is not turned into a retry', async () => {
  const r = rig();
  const fetchImpl = async () => { r.ctl.abort(); throw 'request cancelled'; };
  let calls = 0;
  await assert.rejects(withRetry(() => { calls++; return post(fetchImpl, r.ctl.signal); }, r.opts));
  assert.equal(calls, 1);
  assert.deepEqual(r.sleeps, []);
});

// ---- SSE -----------------------------------------------------------------------------------------------------------

test('sse parses data events across chunk boundaries, CRLF, multi-line data, [DONE] and junk', async () => {
  const enc = new TextEncoder();
  const chunks = ['data: {"a":1}\r\n\r\nevent: x\ndata: {"b"', ':2}\n\ndata: [DONE]\n\n: comment\n\ndata: not json\n\ndata: {"c":\ndata: 3}\n\n'];
  const body = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
  const seen = [];
  for await (const ev of sse(new Response(body))) seen.push(ev);
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('sse: a connection that breaks mid-stream becomes a retryable network error after the events already read', async () => {
  const body = sseStream([{ n: 1 }, { n: 2 }], { failWith: new TypeError('terminated') });
  const seen = [];
  await assert.rejects(
    (async () => { for await (const ev of sse(new Response(body))) seen.push(ev); })(),
    (e) => e instanceof ProviderError && e.kind === 'network' && e.retryable && /terminated/.test(e.message),
  );
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
});

test('sse: a read failure after the signal aborted is rethrown untouched', async () => {
  const ctl = new AbortController();
  const failure = new Error('cancelled by client');
  const body = new ReadableStream({ pull() { ctl.abort(); throw failure; } });
  await assert.rejects((async () => { for await (const _ of sse(new Response(body), ctl.signal)); })(), (e) => e === failure);
});

test('sse: a response without a body is a retryable network error', async () => {
  await assert.rejects((async () => { for await (const _ of sse(new Response(null, { status: 200 }))); })(), (e) => e.kind === 'network' && e.retryable);
});

test('sse: stopping early cancels the underlying stream', async () => {
  let cancelled = false;
  const enc = new TextEncoder();
  const body = new ReadableStream({ pull(c) { c.enqueue(enc.encode('data: {"x":1}\n\n')); }, cancel() { cancelled = true; } });
  for await (const _ of sse(new Response(body))) break;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cancelled, true);
});

// ---- UI notice -----------------------------------------------------------------------------------------------------

test('retryNoticeVars feeds the retryingIn string in both languages', () => {
  const vars = retryNoticeVars({ attempt: 1, maxAttempts: 4, delayMs: 4200, kind: 'server', message: '' });
  assert.deepEqual(vars, { seconds: 5, attempt: 2, max: 4 }, 'seconds round up; attempt is the one about to run');
  assert.equal(retryNoticeVars({ attempt: 3, maxAttempts: 4, delayMs: 0, kind: 'network', message: '' }).seconds, 1, 'never "0s"');
  for (const lang of ['en', 'ru']) {
    const dict = JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), 'utf8'));
    const used = [...dict.retryingIn.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(used, Object.keys(vars).sort(), lang);
  }
});
