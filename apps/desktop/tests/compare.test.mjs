import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPARE_SYSTEM,
  MAX_COLUMNS,
  answerText,
  canContinue,
  canRun,
  columnError,
  compareChatTitle,
  compareReducer,
  continueMessages,
  elapsedMs,
  emptyCompare,
  estimateInput,
  estimateOutput,
  startCompare,
  toggleTarget,
} from '../src/lib/compare.ts';
import { makeError, errorForStatus } from '../src/providers/retry.ts';

const target = (n) => ({ key: `p${n}\nm${n}`, providerId: `p${n}`, model: `m${n}`, label: `Model ${n}` });
const T = [1, 2, 3, 4, 5].map(target);
const text = (s) => [{ type: 'text', text: s }];
const usage = (input, output) => ({ input, output, cached: 0, cacheWrite: 0, reasoning: 0 });
const abortErr = () => new DOMException('Aborted', 'AbortError');
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Collects dispatched actions into a reducer state, like the React component does. */
function harness(adapters, deps = {}) {
  const h = { state: emptyCompare, requests: [], usages: [], clock: 1000, calls: [] };
  h.deps = {
    getAdapter: async (t) => ({
      turn: async (input) => {
        h.calls.push({ t, input });
        return adapters[t.key](input, t);
      },
    }),
    dispatch: (a) => {
      h.state = compareReducer(h.state, a);
    },
    onRequest: (t) => h.requests.push(t.providerId),
    onUsage: (t, u) => h.usages.push([t.providerId, t.model, u]),
    now: () => (h.clock += 10),
    ...deps,
  };
  return h;
}
const col = (h, n) => h.state.columns.find((c) => c.key === target(n).key);
const hangUntilAbort = (i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(abortErr())));

test('init creates one running column per target, drops duplicates, caps at the limit', () => {
  const s = compareReducer(emptyCompare, { type: 'init', prompt: 'hi', targets: [...T, T[0]], now: 5, input: 7 });
  assert.equal(s.prompt, 'hi');
  assert.equal(s.columns.length, MAX_COLUMNS);
  assert.ok(s.columns.every((c) => c.status === 'running' && c.text === '' && c.start === 5 && c.input === 7));
});

test('text appends and counts chars; done freezes the column; later events are ignored', () => {
  let s = compareReducer(emptyCompare, { type: 'init', prompt: 'q', targets: [T[0], T[1]], now: 0, input: 1 });
  const k = T[0].key;
  s = compareReducer(s, { type: 'text', key: k, delta: 'ab' });
  s = compareReducer(s, { type: 'text', key: k, delta: 'cde' });
  assert.equal(s.columns[0].text, 'abcde');
  assert.equal(estimateOutput(s.columns[0]), 2);
  s = compareReducer(s, { type: 'done', key: k, now: 50, text: 'final', usage: usage(3, 4) });
  assert.equal(s.columns[0].status, 'done');
  assert.equal(s.columns[0].text, 'final');
  assert.equal(elapsedMs(s.columns[0], 9999), 50);
  assert.equal(compareReducer(s, { type: 'text', key: k, delta: 'late' }), s);
  assert.equal(compareReducer(s, { type: 'fail', key: k, now: 60, error: { message: 'x' } }), s);
  assert.equal(s.columns[1].status, 'running');
  assert.equal(elapsedMs(s.columns[1], 30), 30);
});

test('unknown keys and reset', () => {
  const s = compareReducer(emptyCompare, { type: 'init', prompt: 'q', targets: [T[0]], now: 0, input: 1 });
  assert.equal(compareReducer(s, { type: 'text', key: 'nope', delta: 'x' }), s);
  assert.equal(compareReducer(s, { type: 'reset' }), emptyCompare);
});

test('toggleTarget adds, removes and refuses a fifth column', () => {
  let list = [];
  for (const t of T.slice(0, 4)) list = toggleTarget(list, t);
  assert.equal(list.length, 4);
  assert.equal(toggleTarget(list, T[4]), list);
  assert.equal(toggleTarget(list, T[1]).length, 3);
  assert.deepEqual(toggleTarget([], T[0]), [T[0]]);
});

test('canRun needs a prompt, 2-4 models and no active run', () => {
  assert.equal(canRun('hi', [T[0]]), false);
  assert.equal(canRun('  ', [T[0], T[1]]), false);
  assert.equal(canRun('hi', [T[0], T[1]]), true);
  assert.equal(canRun('hi', T.slice(0, 4)), true);
  assert.equal(canRun('hi', T), false);
  assert.equal(canRun('hi', [T[0], T[1]], true), false);
});

test('parallel run: read-only turns, streaming, usage recorded, both columns done', async () => {
  const h = harness({
    [T[0].key]: async (i) => {
      i.onText('Hel');
      i.onText('lo');
      return { parts: text('Hello'), usage: usage(10, 2) };
    },
    [T[1].key]: async (i) => {
      i.onText('Yo');
      return { parts: text('Yo'), usage: undefined };
    },
  });
  const run = startCompare([T[0], T[1]], 'say hi', h.deps);
  await run.settled();
  assert.equal(h.calls.length, 2);
  for (const { input } of h.calls) {
    assert.deepEqual(input.tools, []);
    assert.equal(input.access, 'readonly');
    assert.equal(input.computer, undefined);
    assert.equal(input.system, COMPARE_SYSTEM);
    assert.deepEqual(input.messages, [{ role: 'user', parts: text('say hi') }]);
  }
  assert.deepEqual(h.requests, ['p1', 'p2']);
  assert.deepEqual(h.usages, [['p1', 'm1', usage(10, 2)]]);
  assert.equal(col(h, 1).status, 'done');
  assert.equal(col(h, 1).text, 'Hello');
  assert.deepEqual(col(h, 1).usage, usage(10, 2));
  assert.equal(col(h, 2).usage, undefined);
  assert.ok(col(h, 1).end > col(h, 1).start);
  assert.equal(h.state.columns[0].input, estimateInput(COMPARE_SYSTEM, 'say hi'));
});

test('columns really run concurrently', async () => {
  const open = [];
  const gate = () => new Promise((res) => open.push(res));
  const h = harness(
    Object.fromEntries(
      T.slice(0, 4).map((t) => [
        t.key,
        async () => {
          await gate();
          return { parts: text('ok') };
        },
      ]),
    ),
  );
  const run = startCompare(T.slice(0, 4), 'q', h.deps);
  await tick();
  assert.equal(open.length, 4, 'all four turns started before any finished');
  open.forEach((f) => f());
  await run.settled();
  assert.ok(h.state.columns.every((c) => c.status === 'done'));
});

test('more than four targets: only the first four run', async () => {
  const h = harness(Object.fromEntries(T.map((t) => [t.key, async () => ({ parts: text('ok') })])));
  await startCompare(T, 'q', h.deps).settled();
  assert.equal(h.calls.length, 4);
});

test('a failing column does not affect the others; ProviderError keeps its classification', async () => {
  const h = harness({
    [T[0].key]: async () => {
      throw errorForStatus(429, 'slow down', 5000);
    },
    [T[1].key]: async () => {
      throw new Error('boom');
    },
    [T[2].key]: async () => ({ parts: text('fine') }),
  });
  await startCompare(T.slice(0, 3), 'q', h.deps).settled();
  assert.equal(col(h, 1).status, 'error');
  assert.equal(col(h, 1).error.kind, 'rate_limit');
  assert.equal(col(h, 1).error.status, 429);
  assert.equal(col(h, 1).error.retryable, true);
  assert.match(col(h, 1).error.message, /Rate limit reached/);
  assert.equal(col(h, 2).error.message, 'boom');
  assert.equal(col(h, 2).error.kind, undefined);
  assert.equal(col(h, 3).status, 'done');
});

test('columnError reads kind, status, retryable and attempts', () => {
  const e = makeError('auth', { status: 401, detail: 'bad key' });
  e.attempts = 2;
  assert.deepEqual(columnError(e), { message: e.message, kind: 'auth', status: 401, retryable: false, attempts: 2 });
});

test('empty answer is an error, not a blank done column', async () => {
  const h = harness({ [T[0].key]: async () => ({ parts: [] }), [T[1].key]: async () => ({ parts: text('x') }) });
  await startCompare([T[0], T[1]], 'q', h.deps).settled();
  assert.equal(col(h, 1).status, 'error');
});

test('getAdapter failure becomes a column error and no request is counted', async () => {
  const h = harness({ [T[1].key]: async () => ({ parts: text('x') }) });
  const inner = h.deps.getAdapter;
  h.deps.getAdapter = async (t) => {
    if (t.providerId === 'p1') throw new Error('no key');
    return inner(t);
  };
  await startCompare([T[0], T[1]], 'q', h.deps).settled();
  assert.equal(col(h, 1).error.message, 'no key');
  assert.equal(col(h, 2).status, 'done');
  assert.deepEqual(h.requests, ['p2']);
});

test('stop cancels one column only; its late text and result are dropped', async () => {
  let release;
  const wait = new Promise((r) => (release = r));
  const signals = {};
  const h = harness({
    [T[0].key]: async (i) => {
      signals[1] = i.signal;
      i.onText('partial');
      await new Promise((res) => i.signal.addEventListener('abort', res));
      i.onText('late');
      throw abortErr();
    },
    [T[1].key]: async (i) => {
      signals[2] = i.signal;
      await wait;
      return { parts: text('second'), usage: usage(1, 1) };
    },
  });
  const run = startCompare([T[0], T[1]], 'q', h.deps);
  await tick();
  run.stop(T[0].key);
  assert.equal(col(h, 1).status, 'stopped');
  assert.equal(col(h, 1).text, 'partial');
  assert.equal(signals[1].aborted, true);
  assert.equal(signals[2].aborted, false);
  release();
  await run.settled();
  assert.equal(col(h, 1).status, 'stopped');
  assert.equal(col(h, 1).text, 'partial');
  assert.equal(col(h, 2).status, 'done');
  assert.equal(canContinue(col(h, 1)), false);
  assert.equal(canContinue(col(h, 2)), true);
});

test('usage of a stopped request that still returns is recorded for budgets, but the column stays stopped', async () => {
  const h = harness({
    [T[0].key]: async (i) => {
      await new Promise((res) => i.signal.addEventListener('abort', res));
      return { parts: text('cut'), usage: usage(5, 1) };
    },
    [T[1].key]: async () => ({ parts: text('x') }),
  });
  const run = startCompare([T[0], T[1]], 'q', h.deps);
  await tick();
  run.stopAll();
  await run.settled();
  assert.equal(col(h, 1).status, 'stopped');
  assert.deepEqual(
    h.usages.map((u) => u[0]),
    ['p1'],
  );
});

test('stopAll stops running columns and leaves finished ones alone', async () => {
  const h = harness({
    [T[0].key]: async () => ({ parts: text('quick') }),
    [T[1].key]: hangUntilAbort,
    [T[2].key]: hangUntilAbort,
  });
  const run = startCompare(T.slice(0, 3), 'q', h.deps);
  await tick();
  run.stopAll();
  await run.settled();
  assert.deepEqual(
    h.state.columns.map((c) => c.status),
    ['done', 'stopped', 'stopped'],
  );
});

test('retry notices show up and are cleared by the next text', async () => {
  const info = { attempt: 1, maxAttempts: 4, delayMs: 2000, kind: 'server', status: 503, message: 'x' };
  let mid;
  const h = harness({
    [T[0].key]: async (i) => {
      i.onRetry(info);
      mid = h.state.columns[0].retry;
      i.onText('ok');
      return { parts: text('ok') };
    },
    [T[1].key]: async () => ({ parts: text('x') }),
  });
  await startCompare([T[0], T[1]], 'q', h.deps).settled();
  assert.deepEqual(mid, info);
  assert.equal(col(h, 1).retry, undefined);
});

test('rerun restarts a failed column with a fresh state', async () => {
  let n = 0;
  const h = harness({
    [T[0].key]: async (i) => {
      if (++n === 1) throw errorForStatus(503, 'down');
      i.onText('again');
      return { parts: text('again') };
    },
    [T[1].key]: async () => ({ parts: text('x') }),
  });
  const run = startCompare([T[0], T[1]], 'q', h.deps);
  await run.settled();
  assert.equal(col(h, 1).status, 'error');
  await run.rerun(T[0].key);
  assert.equal(col(h, 1).status, 'done');
  assert.equal(col(h, 1).text, 'again');
  assert.equal(col(h, 1).error, undefined);
  assert.equal(h.calls.length, 3);
});

test('rerun while running silences the superseded run', async () => {
  let n = 0;
  const h = harness({
    [T[0].key]: async (i) => {
      if (++n === 1) {
        await hangUntilAbort(i).catch(() => {
          i.onText('stale');
          throw abortErr();
        });
      }
      i.onText('fresh');
      return { parts: text('fresh') };
    },
    [T[1].key]: async () => ({ parts: text('x') }),
  });
  const run = startCompare([T[0], T[1]], 'q', h.deps);
  await tick();
  await run.rerun(T[0].key);
  await run.settled();
  assert.equal(col(h, 1).status, 'done');
  assert.equal(col(h, 1).text, 'fresh');
});

test('answerText joins text parts only', () => {
  assert.equal(
    answerText([
      { type: 'text', text: ' a' },
      { type: 'activity', id: '1', name: 'x', args: {}, status: 'success' },
      { type: 'text', text: 'b ' },
    ]),
    'ab',
  );
});

test('continueMessages builds the prompt and the attributed answer; title falls back', () => {
  const c = { providerId: 'p1', model: 'm1', text: 'Answer', usage: usage(3, 4), start: 100, end: 1600 };
  const [u, a] = continueMessages('Why?\nmore', c);
  assert.deepEqual(u, { role: 'user', parts: text('Why?\nmore') });
  assert.equal(a.role, 'assistant');
  assert.deepEqual(a.parts, text('Answer'));
  assert.deepEqual(a.meta, { provider: 'p1', model: 'm1', durationMs: 1500, usage: usage(3, 4) });
  assert.equal(continueMessages('q', { ...c, usage: undefined, end: undefined })[1].meta.usage, undefined);
  assert.equal(compareChatTitle('Why?\nmore', 'New chat'), 'Why?');
  assert.equal(compareChatTitle('   ', 'New chat'), 'New chat');
  assert.equal(compareChatTitle('x'.repeat(100), 'n').length, 60);
});
