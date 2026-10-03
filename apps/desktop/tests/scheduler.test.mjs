import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { Scheduler, clampConcurrency, isAbortError } = await import('../src/agent/scheduler.ts');

const gate = () => {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise((r) => setImmediate(r));

test('never runs more than the limit at once and starts the queue in order', async () => {
  const s = new Scheduler(2);
  const started = [];
  const gates = [gate(), gate(), gate(), gate()];
  const jobs = gates.map((g, i) => s.run(async () => { started.push(i); await g.p; return i; }));
  await tick();
  assert.deepEqual(started, [0, 1]);
  assert.equal(s.running, 2);
  assert.equal(s.queued, 2);
  gates[1].open();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  gates[0].open(); gates[2].open(); gates[3].open();
  assert.deepEqual(await Promise.all(jobs), [0, 1, 2, 3]);
  assert.equal(s.running, 0);
  assert.equal(s.queued, 0);
});

test('a failing task frees its slot and rejects only its own promise', async () => {
  const s = new Scheduler(1);
  const a = s.run(async () => { throw new Error('boom'); });
  const b = s.run(async () => 'ok');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'ok');
  // a synchronous throw is handled the same way
  await assert.rejects(s.run(() => { throw new Error('sync'); }), /sync/);
  assert.equal(await s.run(async () => 1), 1);
});

test('aborting a queued task removes it without ever starting it', async () => {
  const s = new Scheduler(1);
  const g = gate();
  let ran = false;
  const first = s.run(async () => { await g.p; });
  const ctl = new AbortController();
  const queued = s.run(async () => { ran = true; }, ctl.signal);
  const third = s.run(async () => 'third');
  await tick();
  assert.equal(s.queued, 2);
  ctl.abort();
  await assert.rejects(queued, (e) => isAbortError(e));
  assert.equal(s.queued, 1);
  g.open();
  await first;
  assert.equal(await third, 'third');
  assert.equal(ran, false);
});

test('an already aborted signal rejects immediately; a running task gets the signal and is not interrupted by the scheduler', async () => {
  const s = new Scheduler(1);
  const done = new AbortController();
  done.abort();
  await assert.rejects(s.run(async () => 1, done.signal), (e) => isAbortError(e));
  const ctl = new AbortController();
  const g = gate();
  let seen;
  const job = s.run(async (signal) => { seen = signal; await g.p; return 'finished'; }, ctl.signal);
  await tick();
  ctl.abort();
  assert.equal(s.running, 1);
  assert.equal(seen, ctl.signal);
  g.open();
  assert.equal(await job, 'finished');
});

test('raising the limit starts waiting tasks, lowering it keeps running ones', async () => {
  const s = new Scheduler(1);
  const gates = [gate(), gate(), gate()];
  const started = [];
  const jobs = gates.map((g, i) => s.run(async () => { started.push(i); await g.p; }));
  await tick();
  assert.deepEqual(started, [0]);
  s.setConcurrency(3);
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  s.setConcurrency(1);
  assert.equal(s.running, 3);
  gates.forEach((g) => g.open());
  await Promise.all(jobs);
});

test('concurrency is clamped, default 3', () => {
  assert.equal(new Scheduler().concurrency, 3);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(99), 8);
  assert.equal(clampConcurrency(NaN), 3);
  assert.equal(clampConcurrency(2.9), 2);
});

test('onChange fires as tasks queue, start and end', async () => {
  const s = new Scheduler(1);
  let n = 0;
  const off = s.onChange(() => n++);
  await s.run(async () => {});
  await tick();
  assert.ok(n >= 3);
  off();
  const before = n;
  await s.run(async () => {});
  await tick();
  assert.equal(n, before);
});
