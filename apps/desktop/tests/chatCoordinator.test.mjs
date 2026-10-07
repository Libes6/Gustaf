import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./helpers/hooks.mjs', import.meta.url);
const { claimChat, waitForChat, chatBusy } = await import('../src/lib/chatCoordinator.ts');
test('interactive and scheduled requests serialize in the same chat, other chats run independently', async () => {
  const release = claimChat(1001);
  assert.ok(release);
  assert.equal(claimChat(1001), null);
  const other = claimChat(1002);
  assert.ok(other);
  let entered = false;
  const pending = waitForChat(1001, new AbortController().signal).then((r) => {
    entered = true;
    return r;
  });
  await Promise.resolve();
  assert.equal(entered, false);
  release();
  const next = await pending;
  assert.equal(entered, true);
  release();
  assert.equal(chatBusy(1001), true);
  next();
  other();
});
test('cancelled scheduled waiter never acquires or releases another run', async () => {
  const release = claimChat(1003);
  const ctl = new AbortController();
  const pending = waitForChat(1003, ctl.signal);
  ctl.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(chatBusy(1003), true);
  release();
});
