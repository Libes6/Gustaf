// The agent loop's Computer Use path against a scripted model and a fake `cu_execute` (tests/helpers/apiStub.mjs):
// approvals per access mode, "allow for this task", factual results and failed steps. Nothing touches the real desktop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { runAgent } = await import('../src/agent/agent.ts');
const { clearActionLog, getActionLog } = await import('../src/agent/actionLogStore.ts');

let n = 0;
const batch = (...actions) => ({
  parts: [{ type: 'tool_call', id: `k${n++}`, name: 'gustaf_computer', args: { actions }, computer: { actions } }],
});
const type = (text) => ({ type: 'type', text });
const key = (...keys) => ({ type: 'keypress', keys });
const click = { type: 'click', x: 1, y: 2 };

async function run(script, { access = 'full', answer = () => true, shot } = {}) {
  state.reset();
  if (shot) state.shot = shot;
  clearActionLog();
  const approvals = [];
  const results = [];
  let i = 0;
  await runAgent({
    root: null,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: {
      supportsComputer: true,
      supportsReasoning: () => false,
      listModels: async () => [],
      turn: async () => script[i++] ?? { parts: [{ type: 'text', text: 'done' }] },
    },
    providerId: 'p',
    model: 'm',
    access,
    computerUse: true,
    allowlist: [],
    signal: new AbortController().signal,
    onText: () => {},
    onMessage: async (m) => {
      if (m.role === 'tool') results.push(...m.parts);
    },
    approve: async (req) => {
      approvals.push(req);
      return answer(req, approvals.length);
    },
  });
  return { approvals, results, executed: state.executed, log: getActionLog().entries };
}

test('Full access: clicks and typing run without asking; Return after typing asks', async () => {
  const r = await run([batch(click, type('Привет')), batch(key('return'))]);
  assert.equal(r.approvals.length, 1, 'only the Return right after typing asks');
  assert.equal(r.approvals[0].reason, 'enterAfterTyping');
  assert.equal(r.approvals[0].allowTask, true);
  assert.equal(r.executed.length, 2);
  assert.equal(r.log[0].approval, 'mode');
  assert.equal(r.log[1].approval, 'user');
});

test('"Allow for this task" approves later risky batches in the same run only', async () => {
  const script = () => [batch(type('a'), key('enter')), batch(type('b'), key('enter')), batch(key('cmd', 'w'))];
  const r = await run(script(), { answer: () => 'task' });
  assert.equal(r.approvals.length, 1);
  assert.equal(r.executed.length, 3);
  // A new run starts without it.
  const again = await run(script(), { answer: () => true });
  assert.equal(again.approvals.length, 3);
});

test('Ask mode keeps confirming every non-screenshot batch and offers no task-wide allow', async () => {
  const r = await run([batch({ type: 'screenshot' }), batch(click), batch(type('x'))], { access: 'auto' });
  assert.equal(r.approvals.length, 2);
  assert.ok(r.approvals.every((a) => !a.allowTask));
  // "task" from the card cannot widen Ask mode either.
  const t = await run([batch(click), batch(click)], { access: 'auto', answer: () => 'task' });
  assert.equal(t.approvals.length, 2);
});

test('a declined batch is not executed', async () => {
  const r = await run([batch(type('x'), key('return'))], { answer: () => false });
  assert.equal(r.executed.length, 0);
  assert.equal(r.results[0].isError, true);
  assert.equal(r.log[0].status, 'declined');
});

test('results are factual summaries with the screenshot; a failed step is an error that still has the screenshot', async () => {
  const ok = await run([batch({ type: 'open_app', name: 'Telegram' }, click)], {
    shot: () => ({
      png: 'PNG',
      width: 1,
      height: 1,
      frontApp: 'Telegram',
      windowTitle: 'Екатерина',
      changed: true,
      settled: true,
      cursor: [1, 2],
    }),
  });
  assert.equal(
    ok.results[0].output,
    'Executed 2 actions. Front app: Telegram — "Екатерина". Cursor: 1,2. Screen changed: yes.',
  );
  assert.equal(ok.results[0].image, 'PNG');
  assert.equal(ok.approvals.length, 0, 'open_app runs without asking in Full access');

  const bad = await run([batch(click, click, click), batch(click)], {
    shot: () => ({ png: 'PNG2', width: 1, height: 1, failedStep: 1, error: 'input unavailable', changed: false }),
  });
  assert.equal(bad.results[0].isError, true);
  assert.equal(bad.results[0].image, 'PNG2');
  assert.match(bad.results[0].output, /^Step 2 of 3 \(click\) failed: input unavailable\. 1 earlier step ran/);
  assert.equal(bad.log[0].status, 'error');
});
