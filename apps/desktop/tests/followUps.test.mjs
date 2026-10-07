// Pure logic of the multi-agent follow-ups: delegate_tasks retries, the budget stop, continue_from arguments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const o = await import('../src/agent/orchestrator.ts');
const core = await import('../src/agent/subagentCore.ts');
const settings = await import('../src/agent/agentSettings.ts');
const budgets = await import('../src/lib/budgets.ts');

const out = (status, report = status) => ({ status, report });
const planOf = (extra = {}, tasks = [{ id: 'a', title: 'A', prompt: 'a', type: 'explore' }]) => {
  const r = o.parsePlanArgs({ tasks, ...extra }, { cancelDependents: true });
  assert.ok(r.ok, r.error);
  return r.value;
};

// ---- retries ----

test('retries: only whole numbers 0-2 are accepted, default 0', () => {
  assert.equal(planOf().retries, 0);
  assert.equal(planOf({ retries: 2 }).retries, 2);
  assert.equal(planOf({ retries: null }).retries, 0);
  for (const bad of [-1, 3, 1.5, '1', true, NaN]) {
    const r = o.parsePlanArgs(
      { tasks: [{ id: 'a', title: 'A', prompt: 'a', type: 'explore' }], retries: bad },
      { cancelDependents: true },
    );
    assert.equal(r.ok, false, String(bad));
    assert.match(r.error, /`retries` must be a whole number from 0 to 2/);
  }
  assert.deepEqual(o.DELEGATE_TOOL.parameters.properties.retries, {
    type: 'integer',
    minimum: 0,
    maximum: 2,
    description: o.DELEGATE_TOOL.parameters.properties.retries.description,
  });
});

test('runWithRetries re-runs only failed attempts, with the backoff, up to the allowed number', async () => {
  const log = [];
  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);
  const script =
    (...statuses) =>
    async (n, last) => {
      log.push([n, last]);
      return out(statuses[n - 1] ?? 'failed', `r${n}`);
    };
  // No retries: one attempt, outcome untouched (no attempts field).
  assert.deepEqual(await o.runWithRetries(script('failed'), { retries: 0, sleep }), out('failed', 'r1'));
  assert.deepEqual(log, [[1, true]]);
  // Fails twice, then completes on the third: attempts = 3, backoff 1 s then 3 s.
  log.length = 0;
  assert.deepEqual(await o.runWithRetries(script('failed', 'failed', 'completed'), { retries: 2, sleep }), {
    status: 'completed',
    report: 'r3',
    attempts: 3,
  });
  assert.deepEqual(log, [
    [1, false],
    [2, false],
    [3, true],
  ]);
  assert.deepEqual(sleeps, [1000, 3000]);
  // Never completes: stops after retries + 1 attempts.
  assert.deepEqual(await o.runWithRetries(script(), { retries: 1, sleep }), {
    status: 'failed',
    report: 'r2',
    attempts: 2,
  });
  // Completed first time: attempts 1. Limit, budget and cancelled are final.
  assert.equal((await o.runWithRetries(script('completed'), { retries: 2, sleep })).attempts, 1);
  for (const s of ['limit', 'budget', 'cancelled'])
    assert.equal((await o.runWithRetries(script(s), { retries: 2, sleep })).attempts, 1, s);
});

test('runWithRetries stops retrying when the signal aborts (also during the pause) and clamps retries', async () => {
  const ctl = new AbortController();
  let n = 0;
  const p = o.runWithRetries(async () => out('failed', `r${++n}`), {
    retries: 2,
    signal: ctl.signal,
    backoffMs: () => 60_000,
  });
  setTimeout(() => ctl.abort(), 20);
  const r = await p;
  assert.equal(n, 1);
  assert.deepEqual(r, { status: 'failed', report: 'r1', attempts: 1 });
  n = 0;
  await o.runWithRetries(async () => out('failed'), {
    retries: 99,
    sleep: async () => {
      n++;
    },
  });
  assert.equal(n, 2, 'at most two retries');
});

test('a dependant waits for the retries of its dependency (the retry loop runs inside the running task)', async () => {
  const plan = planOf({ retries: 1 }, [
    { id: 'a', title: 'A', prompt: 'a', type: 'explore' },
    { id: 'b', title: 'B', prompt: 'b', type: 'explore', dependsOn: ['a'] },
  ]);
  const order = [];
  const outcomes = await o.runPlan(plan, {
    limit: 2,
    run: (task) =>
      o.runWithRetries(
        async (n) => {
          order.push(`${task.id}${n}`);
          return task.id === 'a' && n === 1 ? out('failed') : out('completed');
        },
        { retries: plan.retries, sleep: async () => {} },
      ),
  });
  assert.deepEqual(order, ['a1', 'a2', 'b1']);
  assert.equal(outcomes.get('b').status, 'completed');
  assert.equal(outcomes.get('a').attempts, 2);
});

test('the merged summary states the attempts and the retry allowance only when retries are on', () => {
  const plan = planOf({ retries: 2 }, [
    { id: 'a', title: 'A', prompt: 'a', type: 'explore' },
    { id: 'b', title: 'B', prompt: 'b', type: 'explore' },
  ]);
  const merged = o.mergeReports(
    plan,
    new Map([
      ['a', { ...out('completed'), attempts: 3 }],
      ['b', { ...out('failed'), attempts: 1 }],
    ]),
  );
  assert.match(merged, /Failed tasks were retried up to 2 time\(s\)\./);
  assert.match(merged, /- a "A" \(explore\): completed, 3 attempts/);
  assert.match(merged, /- b "B" \(explore\): failed, 1 attempt\n/);
  const plain = o.mergeReports(planOf(), new Map([['a', out('completed')]]));
  assert.doesNotMatch(plain, /attempt|retried/);
});

// ---- budget stop ----

test('stopOnBudget defaults to on and only an explicit false turns it off', () => {
  assert.equal(settings.DEFAULT_AGENT_SETTINGS.stopOnBudget, true);
  assert.equal(settings.normalizeAgentSettings({}).stopOnBudget, true);
  assert.equal(settings.normalizeAgentSettings({ stopOnBudget: 0 }).stopOnBudget, true);
  assert.equal(settings.normalizeAgentSettings({ stopOnBudget: false }).stopOnBudget, false);
});

test('exceededBudget: only a crossed limit counts; the day is named before the chat; unreadable usage never stops', () => {
  const s = (dayTokens, chatTokens) => ({ dayTokens, chatTokens, warnPercent: 80 });
  const tot = (tokens) => ({ tokens, counted: 1, missing: 0 });
  assert.equal(budgets.exceededBudget(s(100, 100), tot(100), tot(100)), null, 'exactly at the limit is not over it');
  assert.equal(budgets.exceededBudget(s(100, 100), tot(95), tot(50)), null, 'a warning is not a stop');
  assert.equal(budgets.exceededBudget(s(100, 100), tot(101), tot(5)), 'day');
  assert.equal(budgets.exceededBudget(s(100, 100), tot(5), tot(500)), 'chat');
  assert.equal(budgets.exceededBudget(s(100, 100), tot(101), tot(500)), 'day');
  assert.equal(budgets.exceededBudget(s(null, null), tot(1e9), tot(1e9)), null, 'no limit set');
  assert.equal(budgets.exceededBudget(s(100, 100), undefined, undefined), null, 'unreadable usage');
  assert.equal(budgets.exceededBudget(s(100, null), tot(1), tot(1e9)), null);
});

test('the budget stop text names the budget; a budget-stopped run is reported as stopped, not as a limit', () => {
  assert.match(core.budgetStopMessage('day'), /daily token budget is exceeded/);
  assert.match(core.budgetStopMessage('chat'), /chat token budget is exceeded/);
  const report = core.buildReport({
    title: 'T',
    type: 'explore',
    status: 'budget',
    text: 'partial',
    reason: core.budgetStopMessage('day'),
  });
  assert.match(report, /^Subagent "T" \(explore\) was stopped: the daily token budget is exceeded/);
  assert.match(report, /partial/);
});

// ---- continue_from ----

test('spawn_agent accepts continue_from (trimmed, bounded) and describes it in the tool definition', () => {
  const base = { title: 'T', prompt: 'follow up', type: 'explore' };
  assert.equal(core.parseSpawnArgs(base).value.continueFrom, undefined);
  assert.equal(core.parseSpawnArgs({ ...base, continue_from: '  abc-1 ' }).value.continueFrom, 'abc-1');
  assert.equal(core.parseSpawnArgs({ ...base, continue_from: '' }).value.continueFrom, undefined);
  assert.equal(core.parseSpawnArgs({ ...base, continue_from: 5 }).value.continueFrom, undefined);
  assert.equal(core.parseSpawnArgs({ ...base, continue_from: 'x'.repeat(500) }).value.continueFrom.length, 100);
  assert.ok('continue_from' in core.SPAWN_TOOL.parameters.properties);
  assert.deepEqual(core.SPAWN_TOOL.parameters.required, ['title', 'prompt', 'type']);
});
