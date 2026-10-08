// App-level lifecycle of live agent sessions: archiving a chat (the app's "delete") and "Restart agent session"
// release that chat's sessions and no other chat's; closing the window releases everything and stops agent processes
// within a bounded time, even when an agent hangs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
await import('./helpers/apiStub.mjs');
const { liveSessions, sessionKey, releaseChatSessions } = await import('../src/providers/sessionManager.ts');
const { archiveChat } = await import('../src/lib/data.ts');
const { shutdownAgents } = await import('../src/lib/agentShutdown.ts');

function fake(o = {}) {
  const s = {
    released: [],
    live: true,
    alive: () => s.live,
    release: o.release ?? (async (reason) => void (s.released.push(reason), (s.live = false))),
  };
  return s;
}
async function open(chatId, providerId = 'claude', s = fake()) {
  const lease = await liveSessions.acquire(sessionKey({ providerId, chatId, cwd: '/p' }), 'sig', async () => s);
  lease.done();
  return s;
}

test('releasing a chat ends only its own sessions (chat 5 is not chat 55)', async () => {
  const a = await open(5, 'claude');
  const b = await open(5, 'codex');
  const other = await open(55);
  await releaseChatSessions(5);
  assert.deepEqual(a.released, ['manual']);
  assert.deepEqual(b.released, ['manual']);
  assert.deepEqual(other.released, []);
  await liveSessions.releaseAll();
});

test('archiving a chat releases its live sessions; unarchiving starts nothing', async () => {
  const s = await open(7);
  await archiveChat(7, false);
  assert.deepEqual(s.released, []);
  await archiveChat(7);
  assert.deepEqual(s.released, ['manual']);
  assert.equal(liveSessions.size(), 0);
});

test('window close: everything is released, and a hung agent cannot hold the window past the budget', async () => {
  const ok = await open(1);
  await open(2, 'codex', fake({ release: () => new Promise(() => {}) }));
  const started = Date.now();
  await shutdownAgents(100);
  assert.ok(Date.now() - started < 1000, 'bounded');
  assert.deepEqual(ok.released, ['shutdown']);
  assert.equal(liveSessions.size(), 0);
});
