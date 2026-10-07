// The run core shared by interactive sends and scheduled runs (src/lib/chatRunCore.ts) on the real agent loop with a
// scripted model: user message + checkpoint, shadow copy, message persistence and usage, partial activities of an
// interrupted run, failure reporting, finishing the copy and the approval flow.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { scriptedAdapter, say, use, call } = await import('./helpers/scripted.mjs');
const { appendUserMessage, runChatCore, reportRunFailure, finishReviewCopy, createApprover } =
  await import('../src/lib/chatRunCore.ts');
const { createSubagentHost } = await import('../src/agent/subagents.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');

before(() => saveRulesConfig(DEFAULT_RULES));

function harness({ script = [say('hi')], prepare } = {}) {
  state.reset();
  const root = mkdtempSync(join(tmpdir(), 'core-'));
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const { adapter, seen } = scriptedAdapter(script);
  const log = { stored: [], usage: [], bumped: [], results: [], finished: [], ui: [], reviews: [] };
  const deps = {
    addMessage: async (chatId, msg) => (log.stored.push({ chatId, msg }), log.stored.length),
    checkpoint: async () => 'cp1',
    prepareReview: prepare && (async (dir, approve) => prepare(dir, approve, log)),
    finishReview: async (id) => void log.finished.push(id),
    recordUsage: (p, m, u, level) => log.usage.push({ p, m, u, level }),
    bumpUsage: (p) => log.bumped.push(p),
    recordResult: (p, e) => log.results.push({ p, e }),
  };
  const ui = {
    onReview: (r) => log.reviews.push(r.id),
    onNotice: (t) => log.ui.push(['notice', t]),
    onReady: (h) => log.ui.push(['ready', h.length]),
    onText: (d) => log.ui.push(['text', d]),
    onAccepted: (m) => log.ui.push(['accepted', m.role]),
    onMessage: (m, id) => log.ui.push(['message', m.role, id]),
    onActivity: (a) => log.ui.push(['activity', a.length]),
  };
  const input = (over = {}) => ({
    chatId: 7,
    root,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    access: 'readonly',
    target: async () => ({ adapter, providerId: 'p', model: 'm', supportsTools: true, computerUse: false }),
    allowlist: [],
    signal: new AbortController().signal,
    approve: async () => false,
    ...over,
  });
  return { deps, ui, log, seen, input, root };
}

test('appendUserMessage stores the message with the checkpoint and returns the history', async () => {
  const { deps, log } = harness();
  const r = await appendUserMessage(deps, {
    chatId: 7,
    root: '/p',
    parts: [{ type: 'text', text: 'hello' }],
    prior: [{ role: 'assistant', parts: [{ type: 'text', text: 'earlier' }] }],
  });
  assert.deepEqual(
    log.stored.map((s) => [s.chatId, s.msg.role, s.msg.meta.checkpoint]),
    [[7, 'user', 'cp1']],
  );
  assert.equal(r.history.length, 2);
  assert.equal(r.stored.id, 1);
  assert.equal(r.stored.chat_id, 7);
  // Without a root there is nothing to snapshot.
  const none = await appendUserMessage(deps, { chatId: 7, root: null, parts: [{ type: 'text', text: 'x' }] });
  assert.equal(none.msg.meta.checkpoint, undefined);
});

test('a checkpoint failure surfaces unless it is ignored (unattended runs go on without one)', async () => {
  const deps = {
    addMessage: async () => 1,
    checkpoint: async () => {
      throw new Error('no snapshot');
    },
  };
  await assert.rejects(appendUserMessage(deps, { chatId: 1, root: '/p', parts: [] }), /no snapshot/);
  const r = await appendUserMessage(deps, { chatId: 1, root: '/p', parts: [], ignoreCheckpointErrors: true });
  assert.equal(r.msg.meta.checkpoint, undefined);
});

test('a run stores every message in order, counts the tokens once per reply and records the provider result', async () => {
  const { deps, ui, log, input } = harness({ script: [use(call('list_dir', { path: '.' })), say('done')] });
  const r = await runChatCore(input(), deps, ui);
  assert.equal(r.review, null);
  assert.deepEqual(
    log.stored.map((s) => s.msg.role),
    ['assistant', 'tool', 'assistant'],
  );
  assert.equal(log.usage.filter((u) => u.u).length, 2, 'tokens of the two model replies (the tool message has none)');
  assert.deepEqual(log.bumped, ['p']);
  assert.deepEqual(log.results, [{ p: 'p', e: undefined }]);
  const order = log.ui.filter((u) => u[0] === 'accepted' || u[0] === 'message').map((u) => u[0]);
  assert.deepEqual(
    order,
    ['accepted', 'message', 'accepted', 'message', 'accepted', 'message'],
    'accepted comes before the write, message after',
  );
  assert.deepEqual(log.ui[0], ['ready', 1]);
});

test('read-only runs make no shadow copy; writable ones do, work in it and keep it for the caller to finish', async () => {
  const ro = harness({ prepare: (dir) => ({ review: { id: 'r0', workspace: dir } }) });
  await runChatCore(ro.input({ access: 'readonly' }), ro.deps, ro.ui);
  assert.deepEqual(ro.log.reviews, []);

  const copy = mkdtempSync(join(tmpdir(), 'copy-'));
  writeFileSync(join(copy, 'a.txt'), 'copy\n');
  const w = harness({
    script: [use(call('read_file', { path: 'a.txt' })), say('ok')],
    prepare: () => ({ review: { id: 'r1', workspace: copy, linked: ['node_modules'] }, error: 'setup declined' }),
  });
  const history = [
    { role: 'user', parts: [{ type: 'text', text: 'go' }], meta: { responseId: 'resp-1', checkpoint: 'c' } },
  ];
  const r = await runChatCore(w.input({ access: 'auto', history }), w.deps, w.ui);
  assert.equal(r.review.id, 'r1');
  assert.deepEqual(w.log.reviews, ['r1'], 'reported before the model runs, so a failure still finishes it');
  assert.deepEqual(
    w.log.ui.find((u) => u[0] === 'notice'),
    ['notice', 'setup declined'],
  );
  assert.equal(
    w.seen.turns[0].messages[0].meta?.responseId,
    undefined,
    'a copy does not continue the provider conversation',
  );
  assert.equal(w.seen.turns[0].messages[0].meta?.checkpoint, 'c');
  assert.ok(
    w.log.stored.some((s) => s.msg.role === 'tool' && s.msg.parts[0].output.includes('copy')),
    'the tools worked in the copy',
  );
  assert.equal(await finishReviewCopy(w.deps, r.review), undefined);
  assert.deepEqual(w.log.finished, ['r1']);

  // A retry keeps the history as it was (response ids included) and an existing copy is reused, not made again.
  const again = harness({ prepare: () => assert.fail('no new copy') });
  await runChatCore(
    again.input({ access: 'auto', retry: true, review: { id: 'r1', workspace: copy }, history }),
    again.deps,
    again.ui,
  );
  assert.equal(again.seen.turns[0].messages[0].meta.responseId, 'resp-1');
});

test('a failing finishReview is reported, not thrown', async () => {
  const msg = await finishReviewCopy(
    {
      finishReview: async () => {
        throw new Error('busy');
      },
    },
    { id: 'x', workspace: '/w' },
  );
  assert.match(msg, /busy/);
  assert.equal(await finishReviewCopy({}, { id: 'x', workspace: '/w' }), undefined);
  assert.equal(await finishReviewCopy({ finishReview: async () => assert.fail() }, null), undefined);
});

test('an interrupted step keeps its tool cards (running ones as unknown) and the failure is reported once', async () => {
  const act = (id, status) => ({ type: 'activity', id, name: 'run_command', args: {}, status });
  const { deps, ui, log, input } = harness({
    script: [
      (turn) => {
        turn.onActivity(act('a1', 'success'));
        turn.onActivity(act('a2', 'running'));
        throw new Error('stream cut');
      },
    ],
  });
  await assert.rejects(runChatCore(input(), deps, ui), /stream cut/);
  assert.equal(log.stored.length, 1);
  assert.deepEqual(
    log.stored[0].msg.parts.map((p) => p.status),
    ['success', 'unknown'],
  );
  assert.deepEqual(log.stored[0].msg.meta, { provider: 'p', model: 'm' });
  assert.deepEqual(log.results, [], 'the core does not record the failure; reportRunFailure does');
  const message = await reportRunFailure(
    new Error('stream cut'),
    { providerId: 'p', signal: new AbortController().signal, decorate: () => ' (note)' },
    deps,
  );
  assert.equal(message, 'stream cut (note)');
  assert.deepEqual(log.results, [{ p: 'p', e: 'stream cut (note)' }]);
});

test('a run the user stopped reports no failure, does not store the stopped step and records no result', async () => {
  const ctl = new AbortController();
  const { deps, ui, log, input } = harness({
    script: [
      (turn) => {
        ctl.abort();
        return say('too late');
      },
    ],
  });
  // The loop ends with the abort error; the caller sees the signal and treats it as a stop.
  await assert.rejects(runChatCore(input({ signal: ctl.signal }), deps, ui));
  assert.deepEqual(log.stored, []);
  assert.deepEqual(log.results, []);
  assert.equal(await reportRunFailure(new Error('aborted'), { providerId: 'p', signal: ctl.signal }, deps), null);
  assert.deepEqual(log.results, []);
});

test('errors before the model runs (target) are thrown without storing anything', async () => {
  const { deps, ui, log, input } = harness();
  await assert.rejects(
    runChatCore(
      input({
        target: async () => {
          throw new Error('all accounts exhausted');
        },
      }),
      deps,
      ui,
    ),
    /exhausted/,
  );
  assert.deepEqual(log.stored, []);
  assert.deepEqual(log.bumped, []);
});

// ---- approvals ----

function approver(over = {}) {
  const log = { badges: [], ended: 0, shown: [], withdrawn: 0, answers: [] };
  const ctl = new AbortController();
  let answer;
  const ask = createApprover({
    chatId: 3,
    signal: ctl.signal,
    who: (req) => req.agent ?? 'main',
    beginApproval: (chatId, who) => (log.badges.push([chatId, who]), () => void log.ended++),
    present: (req, a) => (log.shown.push(req), (answer = a), () => void log.withdrawn++),
    onAnswer: (req, ok, always) => log.answers.push([ok, always]),
    ...over,
  });
  return { ask, log, ctl, answer: (...a) => answer(...a) };
}
const cmd = { kind: 'command', command: 'npm publish' };

test('approver: shows the request with a badge, resolves once, and cleans up', async () => {
  const a = approver();
  const p = a.ask(cmd);
  assert.deepEqual(a.log.badges, [[3, 'main']]);
  a.answer(true, true);
  a.answer(false);
  assert.equal(await p, true);
  assert.deepEqual([a.log.ended, a.log.withdrawn, a.log.answers], [1, 1, [[true, true]]]);
});

test('approver: "always" on a Computer Use request becomes "task"; an abort denies', async () => {
  const a = approver();
  const p = a.ask({ kind: 'computer', actions: [] });
  a.answer(true, true);
  assert.equal(await p, 'task');
  const b = approver();
  const q = b.ask(cmd);
  b.ctl.abort();
  assert.equal(await q, false);
  assert.equal(b.log.withdrawn, 1);
  assert.equal(b.log.ended, 1);
  assert.equal(await b.ask(cmd), false, 'after the abort nothing is shown any more');
  assert.equal(b.log.shown.length, 1);
});

test("approver: requests outside `ask` are denied unseen; the timeout is the caller's decision", async () => {
  const a = approver({ ask: (req) => req.kind === 'command' });
  assert.equal(await a.ask({ kind: 'computer', actions: [] }), false);
  assert.deepEqual(a.log.badges, []);
  let timedOut = 0;
  const b = approver({ timeoutMs: 20, onTimeout: () => void timedOut++ });
  const p = b.ask(cmd);
  await sleep(60);
  assert.equal(timedOut, 1, 'the timer only calls back; the caller aborts');
  b.answer(false);
  assert.equal(await p, false);
  const c = approver({ timeoutMs: 20, onTimeout: () => assert.fail('cleared by the answer') });
  const q = c.ask(cmd);
  c.answer(true);
  await q;
  await sleep(50);
});

test('review: null runs in the project folder, takes the pre-run checkpoint and never asks for a copy', async () => {
  const h = harness({
    script: [use(call('write_file', { path: 'a.txt', content: 'edited\n' })), say('ok')],
    prepare: () => assert.fail('no copy for a direct run'),
  });
  const stored = await appendUserMessage(h.deps, { chatId: 7, root: h.root, parts: [{ type: 'text', text: 'go' }] });
  assert.equal(stored.msg.meta.checkpoint, 'cp1', 'the checkpoint is taken before the run, so Revert all works');
  const r = await runChatCore(h.input({ access: 'auto', review: null, history: stored.history }), h.deps, h.ui);
  assert.equal(r.review, null);
  assert.deepEqual(h.log.reviews, []);
  assert.equal(readFileSync(join(h.root, 'a.txt'), 'utf8'), 'edited\n', 'the edit went straight into the project');
  assert.equal(await finishReviewCopy(h.deps, r.review), undefined);
  assert.deepEqual(h.log.finished, []);
});

test('a subagent still works in its own private copy when the chat runs without a review copy', async () => {
  const h = harness({
    script: [use(call('spawn_agent', { title: 'Writer', prompt: 'edit a', type: 'general' })), say('parent done')],
    prepare: () => assert.fail('the chat itself makes no copy'),
  });
  const made = [];
  const copy = mkdtempSync(join(tmpdir(), 'sub-copy-'));
  writeFileSync(join(copy, 'a.txt'), 'hello\n');
  const subagents = createSubagentHost({
    projectRoot: h.root,
    recordTokens: () => {},
    prepare: async (projectRoot) => (
      made.push(projectRoot),
      { review: { id: 'sub1', root: projectRoot, workspace: copy }, setup: null }
    ),
  });
  // The same scripted model answers the parent and (via the subagent system prompt) the child.
  const base = h.input({ access: 'auto', review: null });
  const parentTarget = base.target;
  const inner = (await parentTarget()).adapter;
  const adapter = {
    ...inner,
    turn: async (input) =>
      input.system.includes('You are a subagent')
        ? input.messages.length === 1
          ? {
              parts: [call('write_file', { path: 'a.txt', content: 'by child\n' })],
              usage: { input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 },
            }
          : {
              parts: [{ type: 'text', text: 'child done' }],
              usage: { input: 1, output: 1, cached: 0, cacheWrite: 0, reasoning: 0 },
            }
        : inner.turn(input),
  };
  const r = await runChatCore(
    { ...base, subagents, target: async () => ({ ...(await parentTarget()), adapter }) },
    h.deps,
    h.ui,
  );
  assert.equal(r.review, null);
  assert.deepEqual(made, [h.root], 'the writing subagent prepared its private copy');
  assert.equal(
    readFileSync(join(h.root, 'a.txt'), 'utf8'),
    'hello\n',
    'the project folder is untouched by the subagent',
  );
  assert.equal(readFileSync(join(copy, 'a.txt'), 'utf8'), 'by child\n', 'the subagent wrote in its copy');
});

test('clarifications arrive after a completed tool turn, are persisted, and reach the next model call', async () => {
  let pending = [];
  const clarification = {
    role: 'user',
    parts: [
      { type: 'text', text: 'Use the other file instead' },
      { type: 'image', data: 'abc' },
    ],
  };
  const h = harness({
    script: [
      () => {
        pending.push(clarification);
        return use(call('read_file', { path: 'a.txt' }));
      },
      say('adjusted'),
    ],
  });
  await runChatCore(h.input({ takeClarifications: async () => pending.splice(0) }), h.deps, h.ui);
  assert.equal(h.seen.turns[0].messages.length, 1);
  const messages = h.seen.turns[1].messages;
  assert.equal(messages.at(-2).role, 'tool');
  assert.deepEqual(messages.at(-1), clarification);
  assert.ok(h.log.stored.some((s) => s.msg === clarification));
});

test('clarification queued during final response continues the run at the next boundary', async () => {
  let pending = [];
  const h = harness({
    script: [
      () => {
        pending.push({ role: 'user', parts: [{ type: 'text', text: 'One more detail' }] });
        return say('first');
      },
      say('second'),
    ],
  });
  await runChatCore(h.input({ takeClarifications: async () => pending.splice(0) }), h.deps, h.ui);
  assert.equal(h.seen.turns.length, 2);
  assert.equal(h.seen.turns[1].messages.at(-1).parts[0].text, 'One more detail');
});

test('usage is recorded with the effort level the model really got (none for a model without effort)', async () => {
  for (const [levels, asked, want] of [
    [['low', 'medium', 'high'], 'max', 'high'],
    [['low', 'medium', 'high'], 'low', 'low'],
    [[], 'high', undefined],
  ]) {
    const h = harness({ script: [say('x')] });
    const base = h.input().target;
    const target = async () => ({
      ...(await base()),
      reasoning: asked,
      adapter: { ...(await base()).adapter, supportsReasoning: () => levels.length > 0, reasoningLevels: () => levels },
    });
    await runChatCore(h.input({ target }), h.deps, h.ui);
    assert.equal(h.log.usage[0].level, want, `${levels} / ${asked}`);
  }
});
