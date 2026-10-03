// Pure plan scheduling: validation, dependencies, write ownership, cancellation of dependants, merged summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const o = await import('../src/agent/orchestrator.ts');

const task = (id, extra = {}) => ({ id, title: `T ${id}`, prompt: `do ${id}`, type: 'explore', ...extra });
const plan = (tasks, cancelDependents = true) => {
  const r = o.parsePlanArgs({ tasks }, { cancelDependents });
  assert.ok(r.ok, r.error);
  return r.value;
};

test('parsePlanArgs validates ids, dependencies, cycles and the task count', () => {
  const bad = (tasks, re) => {
    const r = o.parsePlanArgs({ tasks }, { cancelDependents: true });
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  };
  bad([], /non-empty/);
  bad([task('a'), task('a')], /used twice/);
  bad([task('a b')], /id/);
  bad([task('a', { dependsOn: ['x'] })], /unknown task "x"/);
  bad([task('a', { dependsOn: ['a'] })], /itself/);
  bad([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['c'] }), task('c', { dependsOn: ['a'] })], /cycle: a -> b -> c -> a/);
  bad([task('a', { prompt: '' })], /Task "a".*prompt/);
  bad(Array.from({ length: o.MAX_PLAN_TASKS + 1 }, (_, i) => task(`t${i}`)), /at most/);
  const ok = o.parsePlanArgs({ tasks: [task('a', { files: ['../x', 'src/a.ts'], model: 'p/m' })], cancelDependents: false }, { cancelDependents: true });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.tasks[0].files, ['src/a.ts']);
  assert.equal(ok.value.tasks[0].model, 'p/m');
  assert.equal(ok.value.cancelDependents, false);
  assert.equal(o.parsePlanArgs({ tasks: [task('a')] }, { cancelDependents: false }).value.cancelDependents, false);
});

test('ownership: only two writing tasks with overlapping (or undeclared) files conflict', () => {
  const g = (files) => ({ type: 'general', files });
  assert.equal(o.ownershipConflict(g(['src/a.ts']), g(['src/b.ts'])), false);
  assert.equal(o.ownershipConflict(g(['src/a.ts']), g(['src/a.ts'])), true);
  assert.equal(o.ownershipConflict(g(['src']), g(['src/deep/b.ts'])), true, 'folder owns its files');
  assert.equal(o.ownershipConflict(g(['src/']), g(['srcx/b.ts'])), false, 'prefix is per path segment');
  assert.equal(o.ownershipConflict(g([]), g(['src/b.ts'])), true, 'undeclared ownership conflicts with every writer');
  assert.equal(o.ownershipConflict({ type: 'explore', files: [] }, g([])), false, 'readers never conflict');
  assert.equal(o.ownershipConflict({ type: 'review', files: ['src/a.ts'] }, g(['src/a.ts'])), false);
});

test('nextStep respects dependencies, the limit and ownership; skips dependants of a failure', () => {
  const p = plan([task('a'), task('b'), task('c', { dependsOn: ['a'] }), task('d')]);
  assert.deepEqual(o.nextStep(p, new Map(), new Set(), 2).start, ['a', 'b']);
  assert.deepEqual(o.nextStep(p, new Map(), new Set(['a', 'b']), 2).start, []);
  const done = new Map([['a', { status: 'completed', report: '' }]]);
  assert.deepEqual(o.nextStep(p, done, new Set(['b']), 3).start, ['c', 'd']);
  const failed = new Map([['a', { status: 'failed', report: '' }]]);
  assert.deepEqual(o.nextStep(p, failed, new Set(['b']), 3), { start: ['d'], skip: [{ id: 'c', because: 'a' }] });
  const keep = { ...p, cancelDependents: false };
  assert.deepEqual(o.nextStep(keep, failed, new Set(['b']), 3).start, ['c', 'd'], 'dependants run anyway when not cancelling');

  const w = plan([task('w1', { type: 'general', files: ['src/a.ts'] }), task('w2', { type: 'general', files: ['src/a.ts'] }), task('w3', { type: 'general', files: ['lib'] }), task('r', { files: ['src/a.ts'] })]);
  assert.deepEqual(o.nextStep(w, new Map(), new Set(), 4).start, ['w1', 'w3', 'r'], 'w2 waits for w1');
  assert.deepEqual(o.nextStep(w, new Map([['w1', { status: 'completed', report: '' }]]), new Set(['w3', 'r']), 4).start, ['w2']);
});

/** A fake runner: records the order of starts and the peak concurrency; results per id. */
function fakeRun(results = {}, delay = {}) {
  const seen = { order: [], live: 0, peak: 0, deps: {}, overlapping: [] };
  const liveTasks = new Set();
  return {
    seen,
    run: async (t, deps) => {
      for (const other of liveTasks) if (o.ownershipConflict(other, t)) seen.overlapping.push([other.id, t.id]);
      liveTasks.add(t);
      seen.order.push(t.id);
      seen.deps[t.id] = deps.map((d) => `${d.task.id}:${d.outcome.status}`);
      seen.live++;
      seen.peak = Math.max(seen.peak, seen.live);
      await sleep(delay[t.id] ?? 5);
      seen.live--;
      liveTasks.delete(t);
      if (results[t.id] === 'throw') throw new Error(`boom ${t.id}`);
      return { status: results[t.id] ?? 'completed', report: `report ${t.id}` };
    },
  };
}

test('runPlan runs a dependency graph within the limit and passes dependency outcomes', async () => {
  const p = plan([task('a'), task('b'), task('c', { dependsOn: ['a', 'b'] }), task('d'), task('e', { dependsOn: ['c'] })]);
  const f = fakeRun({}, { a: 5, b: 15, d: 5 });
  const out = await o.runPlan(p, { limit: 2, run: f.run });
  assert.deepEqual([...out.keys()], ['a', 'b', 'c', 'd', 'e']);
  assert.ok([...out.values()].every((x) => x.status === 'completed'));
  assert.ok(f.seen.peak <= 2);
  assert.ok(f.seen.order.indexOf('c') > f.seen.order.indexOf('b'));
  assert.ok(f.seen.order.indexOf('e') > f.seen.order.indexOf('c'));
  assert.deepEqual(f.seen.deps.c, ['a:completed', 'b:completed']);
});

test('runPlan never runs overlapping writers at the same time (queues them instead)', async () => {
  const p = plan([
    task('w1', { type: 'general', files: ['src'] }),
    task('w2', { type: 'general', files: ['src/x.ts'] }),
    task('w3', { type: 'general', files: ['docs'] }),
    task('w4', { type: 'general' }),
  ]);
  const f = fakeRun();
  const out = await o.runPlan(p, { limit: 4, run: f.run });
  assert.deepEqual(f.seen.overlapping, []);
  assert.ok([...out.values()].every((x) => x.status === 'completed'));
  assert.equal(f.seen.order.length, 4);
});

test('a failure cancels dependants transitively (or not, when configured); a throw counts as failure', async () => {
  const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] }), task('d')];
  const skipped = [];
  const out = await o.runPlan(plan(tasks), { limit: 3, run: fakeRun({ a: 'throw' }).run, onSkip: (t, because) => skipped.push(`${t.id}<${because}`) });
  assert.equal(out.get('a').status, 'failed');
  assert.match(out.get('a').report, /boom a/);
  assert.equal(out.get('b').status, 'skipped');
  assert.equal(out.get('c').status, 'skipped');
  assert.equal(out.get('d').status, 'completed');
  assert.deepEqual(skipped, ['b<a', 'c<b']);

  const f = fakeRun({ a: 'limit' });
  const kept = await o.runPlan(plan(tasks, false), { limit: 3, run: f.run });
  assert.equal(kept.get('b').status, 'completed');
  assert.deepEqual(f.seen.deps.b, ['a:limit']);
});

test('aborting stops new starts and marks the rest cancelled', async () => {
  const ctl = new AbortController();
  const p = plan([task('a'), task('b', { dependsOn: ['a'] })]);
  const run = async (t) => {
    ctl.abort();
    return { status: 'cancelled', report: `stopped ${t.id}` };
  };
  const out = await o.runPlan(p, { limit: 2, signal: ctl.signal, run });
  assert.equal(out.get('a').status, 'cancelled');
  assert.equal(out.get('b').status, 'cancelled');
  assert.match(out.get('b').report, /before it started/);
});

test('mergeReports lists every task and stays bounded; dependency context is bounded', () => {
  const p = plan([task('a'), task('b', { dependsOn: ['a'] })]);
  const big = 'x'.repeat(50_000);
  const merged = o.mergeReports(p, new Map([['a', { status: 'completed', report: big }], ['b', { status: 'skipped', report: 'Not run' }]]), 6000);
  assert.match(merged, /^Plan finished: 2 task\(s\); 1 completed, 1 skipped\./);
  assert.match(merged, /- b "T b" \(explore, after a\): skipped/);
  assert.ok(merged.length < 6500, String(merged.length));
  assert.match(merged, /report truncated/);
  const ctx = o.dependencyContext([{ task: { id: 'a', title: 'A' }, outcome: { status: 'completed', report: big } }], 2000);
  assert.ok(ctx.length < 2500);
  assert.match(ctx, /NOT in your copy/);
  assert.equal(o.dependencyContext([]), '');
});
