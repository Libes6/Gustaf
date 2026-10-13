// The native simulator helper client (src/device/nativeSim.ts) and the driver's native paths (frames, touch, home),
// against a fake transport / fake session. The helper itself (native/gustaf-sim.m) needs a booted simulator and is
// measured by scripts/device-bench.mjs, not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { createNativeSim } = await import('../src/device/nativeSim.ts');
const { createDriver } = await import('../src/device/driver.ts');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ios = fx('device-ios-helper.json');
const sim = fx('device-simctl.json');
const UDID = '22144834-F40F-4063-A585-2C2BB11A88C5';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A scripted helper process. `handler(req, send, t)` answers requests; ready: the first message (or false: none). */
function fakeProc(handler, ready = { event: 'ready', ok: true, pw: 1206, ph: 2622 }) {
  let listener;
  let resolveClosed;
  const t = {
    written: [],
    stopped: false,
    closed: new Promise((r) => (resolveClosed = r)),
    onMessage(cb) {
      listener = cb;
      if (ready) queueMicrotask(() => cb(ready));
    },
    async write(line) {
      const req = JSON.parse(line);
      t.written.push(req);
      handler?.(req, (m) => listener?.(m), t);
    },
    async stop() {
      t.stopped = true;
      resolveClosed(0);
    },
    crash() {
      resolveClosed(1);
    },
    push: (m) => listener?.(m),
  };
  return t;
}
const frameMsg = (seq, data = 'AAAA') => ({ event: 'frame', seq, data, w: 603, h: 1311, pw: 1206, ph: 2622 });
const ackOk = (req, send) => req.id && send({ id: req.id, ok: true });

test('native: frames are matched to the caller, acknowledged on delivery, and a superseded frame is acknowledged at once', async () => {
  const p = fakeProc(ackOk);
  const n = createNativeSim({ spawn: async () => p });
  const s = await n.open(UDID);
  assert.equal(s.pixelWidth, 1206);
  const next = s.nextFrame(0, 1000);
  p.push(frameMsg(1));
  assert.equal((await next).seq, 1);
  assert.deepEqual(
    p.written.filter((w) => w.op === 'ack'),
    [{ op: 'ack', seq: 1 }],
  );
  // two frames arrive while nobody asks: the older one is dropped and acknowledged, the newer one is delivered
  p.push(frameMsg(2));
  p.push(frameMsg(3));
  const f = await s.nextFrame(1, 1000);
  assert.equal(f.seq, 3);
  assert.deepEqual(
    p.written.filter((w) => w.op === 'ack').map((w) => w.seq),
    [1, 2, 3],
  );
  await n.closeAll();
  assert.equal(p.stopped, true);
});

test('native: with nothing changing, nextFrame returns the latest picture after the timeout; with none yet, undefined', async () => {
  const p = fakeProc(ackOk);
  const s = await createNativeSim({ spawn: async () => p }).open(UDID);
  assert.equal(await s.nextFrame(0, 15), undefined);
  p.push(frameMsg(1));
  assert.equal((await s.nextFrame(1, 15)).seq, 1);
});

test('native: tap / swipe / button / key become requests in call order and resolve when the helper answers', async () => {
  const p = fakeProc((req, send) => setTimeout(() => ackOk(req, send), req.op === 'tap' ? 15 : 1));
  const s = await createNativeSim({ spawn: async () => p }).open(UDID);
  const scr = { sw: 402, sh: 874 };
  s.touch('down', 1, 2, scr);
  await Promise.all([
    s.tap(10, 20, scr),
    s.swipe({ x: 1, y: 2 }, { x: 3, y: 4 }, 100, scr),
    s.button('home'),
    s.key(40),
  ]);
  assert.deepEqual(
    p.written.filter((w) => w.op !== 'ack' && w.op !== 'frames').map((w) => w.op),
    ['touch', 'tap', 'swipe', 'button', 'key', 'button', 'key'],
  );
  const tap = p.written.find((w) => w.op === 'tap');
  assert.deepEqual([tap.x, tap.y, tap.sw, tap.sh, tap.holdMs], [10, 20, 402, 874, 40]);
  const btn = p.written.filter((w) => w.op === 'button');
  assert.deepEqual(
    btn.map((b) => [b.name, b.down]),
    [
      ['home', true],
      ['home', false],
    ],
  );
});

test('native: a refused request rejects with the helper message', async () => {
  const p = fakeProc((req, send) => send({ id: req.id, ok: false, error: 'unknown button' }));
  const s = await createNativeSim({ spawn: async () => p }).open(UDID);
  await assert.rejects(s.button('home'), /unknown button/);
});

test('native: missing private API makes every device unavailable (one spawn only); a missing device only that device', async () => {
  let spawns = 0;
  const reasons = [];
  const n = createNativeSim({
    spawn: async () => (
      spawns++,
      fakeProc(null, { event: 'ready', ok: false, reason: 'SimDeviceLegacyHIDClient missing' })
    ),
    onUnavailable: (u, r) => reasons.push(r),
  });
  assert.equal(await n.open(UDID), undefined);
  assert.equal(await n.open('OTHER'), undefined);
  assert.equal(spawns, 1);
  assert.match(reasons[0], /missing/);
  let spawns2 = 0;
  const m = createNativeSim({
    spawn: async () => (spawns2++, fakeProc(null, { event: 'ready', ok: false, reason: 'simulator not found' })),
  });
  assert.equal(await m.open('A'), undefined);
  assert.equal(await m.open('A'), undefined);
  assert.equal(spawns2, 1, 'that device is not retried');
  assert.equal(await m.open('B'), undefined);
  assert.equal(spawns2, 2);
});

test('native: no binary (spawn throws) -> unavailable for everything, never throws', async () => {
  let spawns = 0;
  const n = createNativeSim({
    spawn: async () => {
      spawns++;
      throw new Error('compiling failed');
    },
  });
  assert.equal(await n.open(UDID), undefined);
  assert.equal(await n.open('B'), undefined);
  assert.equal(spawns, 1);
});

test('native: a helper that never says ready is stopped and reported unavailable', async () => {
  const p = fakeProc(null, null);
  const n = createNativeSim({ spawn: async () => p, readyTimeoutMs: 15 });
  assert.equal(await n.open(UDID), undefined);
  assert.equal(p.stopped, true);
});

test('native: a crash rejects what is in flight, the next open restarts it, and it is given up on after the restarts', async () => {
  const procs = [];
  const n = createNativeSim({
    spawn: async () => {
      const p = fakeProc(null);
      procs.push(p);
      return p;
    },
    maxRestarts: 1,
  });
  const s = await n.open(UDID);
  const pending = s.tap(1, 1, { sw: 1, sh: 1 });
  procs[0].crash();
  await assert.rejects(pending, /stopped/);
  await tick(2);
  assert.equal(n.peek(UDID), undefined);
  const s2 = await n.open(UDID);
  assert.ok(s2 && s2 !== s);
  procs[1].crash();
  await tick(2);
  assert.equal(await n.open(UDID), undefined, 'two crashes with one restart allowed: given up');
  assert.equal(procs.length, 2);
});

// ---------- the driver ----------

const ok = (stdout = '', extra = {}) => ({ code: 0, stdout, stderr: '', ...extra });
const json = (o) => ok(JSON.stringify(o));
function fakeRunner(routes) {
  const calls = [];
  const run = async (script, opts) => {
    calls.push({ script, opts });
    for (const [re, reply] of routes)
      if (re.test(script)) return typeof reply === 'function' ? reply(script, opts) : reply;
    return { code: 127, stdout: '', stderr: `no route for: ${script.slice(0, 200)}` };
  };
  return { run, calls };
}

/** A fake NativeSession: records every call; `frames` is what nextFrame returns, one per call. */
function fakeSession(extra = {}) {
  const calls = [];
  const s = {
    alive: true,
    pixelWidth: 1206,
    pixelHeight: 2622,
    calls,
    frames: [],
    touch: (...a) => calls.push(['touch', ...a]),
    tap: async (...a) => void calls.push(['tap', ...a]),
    swipe: async (...a) => void calls.push(['swipe', ...a]),
    button: async (...a) => void calls.push(['button', ...a]),
    key: async (...a) => void calls.push(['key', ...a]),
    startFrames: (...a) => calls.push(['startFrames', ...a]),
    nextFrame: async (after) =>
      s.frames.shift() ?? {
        seq: after + 1,
        data: 'QUJD',
        width: 603,
        height: 1311,
        pixelWidth: 1206,
        pixelHeight: 2622,
      },
    close: async () => void calls.push(['close']),
    ...extra,
  };
  return s;
}
function fakeNative(session) {
  let opened = false;
  return {
    opens: 0,
    async open() {
      this.opens++;
      opened = true;
      return session;
    },
    peek: () => (opened ? session : undefined),
    async close() {
      session?.calls.push(['closeSession']);
    },
    async closeAll() {},
  };
}
const HELPER_PRESENT = [/test -f .*agent-device\.mjs/, ok('yes\n')];
const SIMCTL_SHOT = [/simctl io .* screenshot/, ok(sim.frameHead_jpeg)];

function nativeDriver(session, routes = []) {
  const native = fakeNative(session);
  const r = fakeRunner([
    HELPER_PRESENT,
    SIMCTL_SHOT,
    [/'open'/, json({ success: true, data: { appBundleId: 'com.apple.springboard' } })],
    [/'snapshot'/, json(ios.snapshot)],
    [/'press'/, json({ success: true, data: { message: 'helper tap' } })],
    ...routes,
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {}, native });
  return { d, native, r, session };
}

test('driver: the first frame comes from simctl while the native helper opens in the background, then the stream takes over', async () => {
  const { d, native, session } = nativeDriver(fakeSession());
  const f1 = await d.frame(UDID);
  assert.equal(f1.mime, 'image/jpeg');
  assert.equal(native.opens, 1, 'opening was started');
  await tick(5);
  assert.equal(d.streaming(UDID), true);
  const f2 = await d.frame(UDID);
  assert.equal(f2.data, 'QUJD', 'the native frame');
  assert.deepEqual(f2.pixels, { width: 603, height: 1311 });
  assert.deepEqual(
    f2.points,
    { width: 402, height: 874 },
    'points from the framebuffer size (3x), not the scaled image',
  );
  assert.equal(session.calls.filter((c) => c[0] === 'startFrames').length, 1);
});

test('driver: native tap / long press / swipe / home / enter skip the helper; a ref is tapped at the centre of its element', async () => {
  const { d, r, session } = nativeDriver(fakeSession());
  await d.snapshot(UDID); // the map, so refs resolve
  await d.frame(UDID);
  await tick(5);
  const helperBefore = r.calls.filter((c) => /agent-device/.test(c.script)).length;
  const res = await d.human.tap(UDID, { x: 100.4, y: 200.6 });
  assert.deepEqual(res, { message: 'Tapped (100, 201)', diff: '', settled: true });
  await d.human.longPress(UDID, { x: 5, y: 6 }, 900);
  await d.human.swipe(UDID, { x: 200, y: 600 }, { x: 200, y: 300 }, 10);
  await d.human.press(UDID, 'home');
  await d.human.press(UDID, 'enter');
  const node = ios.snapshot.data.nodes.find((n) => n.ref === 'e7');
  await d.human.tap(UDID, { ref: 'e7' });
  const kinds = session.calls.map((c) => c[0]).filter((k) => k !== 'startFrames');
  assert.deepEqual(kinds, ['tap', 'tap', 'swipe', 'button', 'key', 'tap']);
  assert.deepEqual(session.calls.find((c) => c[0] === 'tap').slice(1, 4), [100.4, 200.6, { sw: 402, sh: 874 }]);
  assert.equal(session.calls.filter((c) => c[0] === 'tap')[1][4], 900, 'long press holds for its duration');
  assert.equal(session.calls.find((c) => c[0] === 'swipe')[3], 60, 'swipe duration is clamped to 60..600 ms');
  assert.deepEqual(session.calls.find((c) => c[0] === 'key').slice(1), [40]);
  const refTap = session.calls.filter((c) => c[0] === 'tap')[2];
  assert.ok(Math.abs(refTap[1] - (node.rect.x + node.rect.width / 2)) < 1);
  assert.equal(r.calls.filter((c) => /agent-device/.test(c.script)).length, helperBefore, 'no helper call was made');
});

test('driver: when the native call fails the same input goes through the helper instead', async () => {
  const session = fakeSession({
    tap: async () => {
      throw new Error('dead');
    },
  });
  const { d, r } = nativeDriver(session);
  await d.frame(UDID);
  await tick(5);
  const res = await d.human.tap(UDID, { x: 1, y: 2 });
  assert.equal(res.message, 'helper tap');
  assert.ok(r.calls.some((c) => /'press'/.test(c.script)));
});

test('driver: a ref that is not in the last map is tapped through the helper', async () => {
  const { d, session } = nativeDriver(fakeSession());
  await d.frame(UDID);
  await tick(5);
  const res = await d.human.tap(UDID, { ref: 'e999' });
  assert.equal(res.message, 'helper tap');
  assert.equal(session.calls.filter((c) => c[0] === 'tap').length, 0);
});

test('driver: raw touches go to the helper in order with the screen size; up without down is not ours; no native -> false', async () => {
  const { d, session } = nativeDriver(fakeSession());
  assert.equal(d.human.touch(UDID, 'down', { x: 1, y: 1 }), false, 'native not open yet');
  await d.frame(UDID);
  await tick(5);
  assert.equal(d.human.touch(UDID, 'move', { x: 1, y: 1 }), false, 'move without a down');
  assert.equal(d.human.touch(UDID, 'down', { x: 10, y: 20 }), true);
  assert.equal(d.human.touch(UDID, 'move', { x: 10, y: 60 }), true);
  assert.equal(d.human.touch(UDID, 'up', { x: 10, y: 90 }), true);
  assert.deepEqual(
    session.calls.filter((c) => c[0] === 'touch').map((c) => [c[1], c[2], c[3]]),
    [
      ['down', 10, 20],
      ['move', 10, 60],
      ['up', 10, 90],
    ],
  );
  assert.deepEqual(session.calls.find((c) => c[0] === 'touch')[4], { sw: 402, sh: 874 });
  const plain = createDriver({ run: fakeRunner([HELPER_PRESENT]).run, appDataDir: '/d' });
  assert.equal(plain.human.touch(UDID, 'down', { x: 1, y: 1 }), false);
  assert.equal(plain.streaming(UDID), false);
});

test('driver: a touch whose up never arrives is lifted after a while', async () => {
  const { d, session } = nativeDriver(fakeSession());
  await d.frame(UDID);
  await tick(5);
  d.human.touch(UDID, 'down', { x: 1, y: 1 });
  d.human.touch(UDID, 'move', { x: 2, y: 3 });
  await d.release(UDID); // ends the device's state, and with it the watchdog and the native session
  assert.ok(session.calls.some((c) => c[0] === 'closeSession'));
});

test('driver: iOS frames fall back to simctl when the native helper is unavailable', async () => {
  const native = {
    async open() {
      return undefined;
    },
    peek: () => undefined,
    async close() {},
    async closeAll() {},
  };
  const r = fakeRunner([HELPER_PRESENT, SIMCTL_SHOT]);
  const d = createDriver({ run: r.run, appDataDir: '/d', native });
  const f = await d.frame(UDID);
  assert.equal(f.mime, 'image/jpeg');
  assert.equal(d.streaming(UDID), false);
});
