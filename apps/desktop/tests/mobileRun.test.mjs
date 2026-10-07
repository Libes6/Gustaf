// Messages sent from a phone on the real agent loop: scripted model, real temporary project, in-memory chat store. Covers the
// whole-history prompt, model choice, the unattended safety rules (no "full", CLI agents read-only), a busy chat, stop,
// and the failure notes written into the chat.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { startMobileSend, stopMobileRun, mobileRunning } = await import('../src/lib/mobileRun.ts');
const { claimChat } = await import('../src/lib/chatCoordinator.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');

before(() => saveRulesConfig(DEFAULT_RULES));

const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
const say = (text) => ({ parts: [{ type: 'text', text }], usage });
const text = (role, t, meta) => ({ role, parts: [{ type: 'text', text: t }], ...(meta ? { meta } : {}) });

function harness({
  script = [say('hi from the model')],
  chat = { projectId: 1, workspace: false },
  history = [],
  own = false,
  access = 'auto',
  resolveError,
  project = 'same',
} = {}) {
  state.reset();
  const root = mkdtempSync(join(tmpdir(), 'mobile-'));
  writeFileSync(join(root, 'a.txt'), 'hello\n');
  const seen = { turns: [], messages: [], created: [], resolved: [], live: 0, ended: 0 };
  let i = 0;
  const adapter = {
    supportsComputer: true,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      seen.turns.push({ access: input.access, messages: [...input.messages], computer: input.computer });
      const next = script[i++] ?? say('done');
      return typeof next === 'function' ? next(input) : next;
    },
  };
  const deps = {
    now: Date.now,
    resolve: async (providerId, model) => (
      seen.resolved.push([providerId, model]),
      resolveError ? { error: resolveError } : { adapter, supportsTools: true, ownTools: own }
    ),
    projectRoot: (id) => (id === null ? null : project === 'gone' ? undefined : root),
    allowlist: () => [],
    reasoning: () => 'medium',
    access: () => access,
    findChat: async () => null,
    createChat: async (projectId, title) => (seen.created.push({ projectId, title }), 77),
    addMessage: async (chatId, msg) => (seen.messages.push({ chatId, msg }), seen.messages.length),
    beginApproval: () => () => {},
    askUser: () => () => {},
    recordUsage: () => {},
    bumpUsage: () => {},
    recordResult: () => {},
    live: () => (
      seen.live++,
      {
        text() {},
        toolResult() {},
        activities() {},
        retry() {},
        message() {},
        approval: () => () => {},
        end: () => void seen.ended++,
      }
    ),
    note: (kind, detail) => `${kind}:${detail ?? ''}`,
    loadChat: async () => chat,
    loadHistory: async () => history,
    defaultTarget: () => ({ providerId: 'desktop', model: 'sel' }),
  };
  return { deps, seen };
}

/** The run goes on after the call returns; wait for it to release the chat. */
async function finished(chatId) {
  for (let i = 0; i < 200 && mobileRunning(chatId); i++) await sleep(10);
  assert.equal(mobileRunning(chatId), false, 'the run ended');
}

test('a message goes to the model with the whole chat history and the answer is stored', async () => {
  const history = [
    text('user', 'earlier question'),
    text('assistant', 'earlier answer', { provider: 'p1', model: 'm1' }),
  ];
  const { deps, seen } = harness({ history });
  const r = await startMobileSend(deps, { chatId: 5, text: 'and now?' });
  assert.deepEqual(r, { ok: true, chatId: 5 });
  await finished(5);
  assert.deepEqual(
    seen.messages.map((m) => [m.chatId, m.msg.role]),
    [
      [5, 'user'],
      [5, 'assistant'],
    ],
  );
  assert.equal(seen.messages[0].msg.parts[0].text, 'and now?');
  assert.deepEqual(
    seen.turns[0].messages.map((m) => m.parts[0].text),
    ['earlier question', 'earlier answer', 'and now?'],
  );
  assert.deepEqual(seen.resolved[0], ['p1', 'm1'], 'the model that answered last keeps answering');
  assert.equal(seen.live, 1);
  assert.equal(seen.ended, 1);
});

test('model choice: an explicit one wins, then the last answer, then the desktop selection', async () => {
  let h = harness();
  await startMobileSend(h.deps, { chatId: 5, text: 'x', providerId: 'px', model: 'mx' });
  await finished(5);
  assert.deepEqual(h.seen.resolved[0], ['px', 'mx']);
  h = harness();
  await startMobileSend(h.deps, { chatId: 5, text: 'x' });
  await finished(5);
  assert.deepEqual(h.seen.resolved[0], ['desktop', 'sel']);
});

test('safety rules of an unattended run: never "full", no Computer Use, CLI agents read-only', async () => {
  let h = harness({ access: 'full' });
  await startMobileSend(h.deps, { chatId: 5, text: 'x' });
  await finished(5);
  assert.equal(h.seen.turns[0].access, 'auto');
  assert.equal(h.seen.turns[0].computer, undefined);
  h = harness({ own: true, access: 'auto' });
  await startMobileSend(h.deps, { chatId: 5, text: 'x' });
  await finished(5);
  assert.equal(h.seen.turns[0].access, 'readonly');
  h = harness({ access: 'readonly' });
  await startMobileSend(h.deps, { chatId: 5, text: 'x' });
  await finished(5);
  assert.equal(h.seen.turns[0].access, 'readonly');
});

test('a new chat is created in the project, titled from the first line', async () => {
  const { deps, seen } = harness();
  const r = await startMobileSend(deps, { projectId: 1, text: '\n  Fix the login bug\nmore details' });
  assert.deepEqual(r, { ok: true, chatId: 77 });
  assert.deepEqual(seen.created, [{ projectId: 1, title: 'Fix the login bug' }]);
  await finished(77);
  assert.equal(seen.messages[0].chatId, 77);
  const t = harness();
  await startMobileSend(t.deps, { projectId: 1, text: 'x', title: ' Named ' });
  assert.equal(t.seen.created[0].title, 'Named');
  await finished(77);
});

test('refusals: unknown chat or project, workspace chats, no provider, a provider that cannot be used', async () => {
  assert.deepEqual(await startMobileSend(harness({ chat: null }).deps, { chatId: 5, text: 'x' }), {
    ok: false,
    code: 'not_found',
    message: 'No such chat',
  });
  assert.equal(
    (await startMobileSend(harness({ chat: { projectId: 1, workspace: true } }).deps, { chatId: 5, text: 'x' })).code,
    'failed',
  );
  assert.equal((await startMobileSend(harness({ project: 'gone' }).deps, { chatId: 5, text: 'x' })).code, 'not_found');
  assert.equal((await startMobileSend(harness().deps, { text: 'x' })).code, 'bad_request');
  const none = harness();
  none.deps.defaultTarget = () => null;
  assert.equal((await startMobileSend(none.deps, { chatId: 5, text: 'x' })).code, 'failed');
  const bad = harness({ resolveError: 'Provider is disabled' });
  assert.deepEqual(await startMobileSend(bad.deps, { chatId: 5, text: 'x' }), {
    ok: false,
    code: 'failed',
    message: 'Provider is disabled',
  });
  assert.equal(bad.seen.messages.length, 0, 'nothing is written when the run was refused');
});

test('a chat that is busy on the desktop is refused, and nothing is created for it', async () => {
  const { deps, seen } = harness();
  const release = claimChat(5);
  const r = await startMobileSend(deps, { chatId: 5, text: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'busy');
  assert.equal(seen.messages.length, 0);
  release();
  assert.equal((await startMobileSend(harness().deps, { chatId: 5, text: 'x' })).ok, true);
  await finished(5);
});

test('stop aborts a phone run and the chat says so; stopping nothing is false', async () => {
  assert.equal(stopMobileRun(404), false);
  const { deps, seen } = harness({
    script: [
      async (input) => {
        await new Promise((_, reject) =>
          input.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
        );
      },
    ],
  });
  await startMobileSend(deps, { chatId: 5, text: 'long task' });
  await sleep(30);
  assert.equal(mobileRunning(5), true);
  assert.equal(stopMobileRun(5), true);
  await finished(5);
  assert.ok(
    seen.messages.some((m) => m.msg.role === 'assistant' && m.msg.parts[0].text.startsWith('stopped')),
    'a note says it was stopped',
  );
});

test('a failing provider writes a failure note into the chat and releases it', async () => {
  const { deps, seen } = harness({
    script: [
      () => {
        throw new Error('boom');
      },
    ],
  });
  await startMobileSend(deps, { chatId: 5, text: 'x' });
  await finished(5);
  assert.ok(seen.messages.some((m) => m.msg.role === 'assistant' && m.msg.parts[0].text.startsWith('failed:')));
  assert.equal(claimChat(5)?.() === undefined, true, 'the chat can be claimed again');
});
