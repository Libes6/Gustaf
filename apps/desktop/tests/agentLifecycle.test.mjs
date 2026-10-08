// Agent lifecycle core (src/providers/sessionManager.ts, src/providers/lifecycle.ts): live sessions are reused only
// when idle and launched the same way, released after idle unless background work pins them (up to a cap), and
// follow-ups are delivered once, in order, never twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { createSessionManager } = await import('../src/providers/sessionManager.ts');
const { followUpPump, interrupted, partialOf, capabilitiesOf } = await import('../src/providers/lifecycle.ts');

function fakeSession(o = {}) {
  const s = {
    released: [],
    live: true,
    bg: o.bg ?? (() => false),
    alive: () => s.live,
    backgroundWork: () => s.bg(),
    async release(reason) {
      s.released.push(reason);
      s.live = false;
    },
  };
  return s;
}

test('a live session is reused for the next turn and replaced when its launch signature changes', async () => {
  const m = createSessionManager({ idleMs: 10_000 });
  const opened = [];
  const open = async () => {
    const s = fakeSession();
    opened.push(s);
    return s;
  };
  const a = await m.acquire('k', 'sig1', open);
  assert.equal(a.reused, false);
  a.done();
  const b = await m.acquire('k', 'sig1', open);
  assert.equal(b.reused, true);
  assert.equal(b.session, a.session);
  b.done();
  const c = await m.acquire('k', 'sig2', open);
  assert.equal(c.reused, false);
  assert.deepEqual(opened[0].released, ['replaced']);
  c.done({ broken: true });
  assert.deepEqual(opened[1].released, ['error']);
  assert.equal(m.size(), 0);
});

test('a dead session is never reused; concurrent acquires of one key open it once', async () => {
  const m = createSessionManager({ idleMs: 10_000 });
  let opens = 0;
  const open = async () => {
    opens++;
    await sleep(5);
    return fakeSession();
  };
  const first = m.acquire('k', 's', open);
  const second = m.acquire('k', 's', open); // waits for the lock, then sees the first lease still busy
  const a = await first;
  a.done();
  const b = await second;
  assert.equal(opens, 1);
  assert.equal(b.reused, true);
  b.session.live = false;
  b.done();
  const c = await m.acquire('k', 's', open);
  assert.equal(c.reused, false);
  assert.equal(opens, 2);
  c.done();
  await m.releaseAll();
});

test('idle release waits for background work, but not past the pin cap', async () => {
  let t = 0;
  const m = createSessionManager({ idleMs: 5, maxPinMs: 100, now: () => t });
  let bg = true;
  const s = fakeSession({ bg: () => bg });
  const lease = await m.acquire('k', 's', async () => s);
  lease.done();
  await sleep(30);
  assert.deepEqual(s.released, [], 'pinned while background work runs');
  bg = false;
  // The pin re-checks every minute; a fresh lease and an idle turn without background work releases quickly.
  const again = await m.acquire('k', 's', async () => fakeSession());
  assert.equal(again.reused, true);
  again.done();
  await sleep(30);
  assert.deepEqual(s.released, ['idle']);
});

test('follow-ups: delivered once and in order; a turn that cannot take them leaves them queued', async () => {
  let queue = ['a', 'b'];
  const wakes = new Set();
  const stored = [];
  const ch = {
    onWake: (cb) => (wakes.add(cb), () => wakes.delete(cb)),
    take: async () => queue.map((text) => ({ role: 'user', parts: [{ type: 'text', text }] })),
    delivered: async (msgs) => {
      for (const m of msgs) stored.push(m.parts[0].text);
      queue = queue.filter((q) => !msgs.some((m) => m.parts[0].text === q));
    },
  };
  const sent = [];
  const close = followUpPump(ch, async (msgs) => {
    sent.push(msgs.map((m) => m.parts[0].text));
    await sleep(5);
    return true;
  });
  // A wake while the first delivery is in flight runs once more afterwards.
  queue.push('c');
  for (const cb of wakes) cb();
  await sleep(30);
  await close();
  assert.deepEqual(stored, ['a', 'b', 'c']);
  assert.equal(sent.flat().length, 3, 'nothing sent twice');
  assert.equal(wakes.size, 0, 'unsubscribed on close');

  queue = ['late'];
  const stored2 = [];
  const close2 = followUpPump({ ...ch, delivered: async (m) => stored2.push(...m) }, async () => false);
  await sleep(5);
  await close2();
  assert.deepEqual(stored2, [], 'a refused delivery is not stored');
  assert.deepEqual(queue, ['late'], 'and stays queued for the next turn');
});

test('an interrupted turn carries its partial output; capabilities come from data', () => {
  const e = interrupted({ parts: [{ type: 'text', text: 'half' }], responseId: 'sess-1' });
  assert.equal(e.name, 'AbortError');
  assert.equal(partialOf(e).responseId, 'sess-1');
  assert.equal(partialOf(new Error('x')), undefined);
  assert.equal(capabilitiesOf({ kind: 'cli', cli: 'claude' }).followUp, 'steer');
  assert.equal(capabilitiesOf({ kind: 'cli', cli: 'codex' }, { codexExec: true }).followUp, 'restart');
  assert.equal(capabilitiesOf({ kind: 'cli', cli: 'cursor-agent' }).liveSession, false);
  assert.equal(capabilitiesOf({ kind: 'openai' }).softInterrupt, false);
});
