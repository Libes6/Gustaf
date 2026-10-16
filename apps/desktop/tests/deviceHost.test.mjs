// The long-lived helper host (src/device/helperHost.ts, hostScript.ts) and the driver's fast paths that use it: framing
// and ordering, crashes, restarts, the CLI fallback, no replay of a tap, the human path (no settle, no snapshot) and
// background snapshots that actions overtake. Everything runs against fakes: a fake transport, a fake runner and, for
// the real host script, a fake `agent-device` client module run by node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { createHelperHost, HostError } = await import('../src/device/helperHost.ts');
const { HOST_SCRIPT } = await import('../src/device/hostScript.ts');
const { createDriver } = await import('../src/device/driver.ts');

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const ios = fx('device-ios-helper.json');
const UDID = '22144834-F40F-4063-A585-2C2BB11A88C5';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A scripted transport: `handler(req, reply)` decides what the "host" answers; `crash()` ends it. */
function fakeTransport(handler, { ready = true } = {}) {
  let listener;
  let resolveClosed;
  const t = {
    written: [],
    stopped: false,
    closed: new Promise((r) => (resolveClosed = r)),
    onMessage(cb) {
      listener = cb;
      if (ready) queueMicrotask(() => cb({ ready: true }));
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
  };
  return t;
}

const okReply = (id, data = {}) => ({ id, reply: { success: true, data } });

test('host: replies are matched by id even when they arrive out of order, and requests are written in call order', async () => {
  const t = fakeTransport((req, reply) => {
    // The first call answers last.
    setTimeout(() => reply(okReply(req.id, { n: req.argv[0] })), req.argv[0] === 'a' ? 20 : 1);
  });
  const host = createHelperHost({ spawn: async () => t });
  const [a, b, c] = await Promise.all([host.call(['a'], 1000), host.call(['b'], 1000), host.call(['c'], 1000)]);
  assert.deepEqual(
    t.written.map((w) => w.argv[0]),
    ['a', 'b', 'c'],
  );
  assert.equal(JSON.parse(a.reply).data.n, 'a');
  assert.equal(JSON.parse(b.reply).data.n, 'b');
  assert.equal(JSON.parse(c.reply).data.n, 'c');
  await host.close();
  assert.equal(t.stopped, true);
});

test('host: an unmapped command is reported as unsupported', async () => {
  const t = fakeTransport((req, reply) => reply({ id: req.id, unsupported: true }));
  const host = createHelperHost({ spawn: async () => t });
  assert.deepEqual(await host.call(['bogus'], 1000), { unsupported: true });
});

test('host: a crash with a call in flight rejects it as dispatched; the next call starts a new host', async () => {
  let starts = 0;
  const first = fakeTransport(() => {});
  const second = fakeTransport((req, reply) => reply(okReply(req.id)));
  const host = createHelperHost({ spawn: async () => (starts++ === 0 ? first : second) });
  const pending = host.call(['press', '1', '2'], 1000);
  await tick(5);
  first.crash();
  await assert.rejects(pending, (e) => e instanceof HostError && e.code === 'host-crashed' && e.dispatched === true);
  const r = await host.call(['snapshot'], 1000);
  assert.equal(r.unsupported, false);
  assert.equal(starts, 2);
});

test('host: it is given up on after repeated start failures, then `available` is false (CLI only)', async () => {
  let starts = 0;
  const host = createHelperHost({
    spawn: async () => {
      starts++;
      throw new Error('no node');
    },
    maxFailures: 2,
  });
  await assert.rejects(host.call(['x'], 100), (e) => e.code === 'host-unavailable' && e.dispatched === false);
  assert.equal(host.available, true);
  await assert.rejects(host.call(['x'], 100), (e) => e.code === 'host-unavailable');
  assert.equal(host.available, false);
  await assert.rejects(host.call(['x'], 100), (e) => e.code === 'host-unavailable');
  assert.equal(starts, 2, 'no more start attempts once given up');
});

test('host: a host that never says ready is stopped and reported unavailable', async () => {
  const t = fakeTransport(undefined, { ready: false });
  const host = createHelperHost({ spawn: async () => t, readyTimeoutMs: 20 });
  await assert.rejects(host.call(['x'], 100), (e) => e.code === 'host-unavailable');
  assert.equal(t.stopped, true);
});

test('host: a call that times out rejects as dispatched and its late answer is ignored', async () => {
  let late;
  const t = fakeTransport((req, reply) => {
    if (req.argv[0] === 'slow') late = () => reply(okReply(req.id, { late: true }));
    else reply(okReply(req.id, { fast: true }));
  });
  const host = createHelperHost({ spawn: async () => t });
  await assert.rejects(host.call(['slow'], 20), (e) => e.code === 'host-timeout' && e.dispatched === true);
  late();
  const r = await host.call(['fast'], 1000);
  assert.equal(JSON.parse(r.reply).data.fast, true);
});

test('host script: maps CLI-style argv to client calls and returns the CLI reply shape (fake client, real node)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gustaf-host-'));
  writeFileSync(join(dir, 'host.mjs'), HOST_SCRIPT);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(
    join(dir, 'client.mjs'),
    `const rec = (n) => async (o) => { if (o.text === 'boom') { const e = new Error('Gesture trajectory does not fit'); e.code = 'COMMAND_FAILED'; e.details = { hint: 'h', reason: 'r' }; throw e; } return { call: n, opts: o, message: 'ok ' + n }; };
export const createAgentDeviceClient = () => ({
  apps: { open: rec('open') }, capture: { snapshot: rec('snapshot') },
  interactions: { press: rec('press'), longPress: rec('longPress'), swipe: rec('swipe'), pan: rec('pan'), type: rec('type'), fill: rec('fill'), scroll: rec('scroll') },
  command: { home: rec('home'), back: rec('back'), appSwitcher: rec('appSwitcher'), keyboard: rec('keyboard') },
  sessions: { close: rec('close') },
});`,
  );
  const p = spawn(process.execPath, [join(dir, 'host.mjs'), dir], {
    env: { ...process.env, GUSTAF_HOST_CLIENT: new URL(`file://${join(dir, 'client.mjs')}`).href },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waiting = new Map();
  let ready;
  const readyP = new Promise((r) => (ready = r));
  createInterface({ input: p.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    if (m.ready) ready(m);
    else waiting.get(m.id)?.(m);
  });
  let n = 0;
  const call = (argv) =>
    new Promise((res) => {
      const id = ++n;
      waiting.set(id, res);
      p.stdin.write(
        JSON.stringify({ id, argv: [...argv, '--session', 's1', '--udid', UDID, '--platform', 'ios', '--json'] }) +
          '\n',
      );
    });
  try {
    assert.equal((await readyP).version, '9.9.9');
    const press = await call(['press', '@e7', '--settle']);
    assert.deepEqual(press.reply.data.opts, { session: 's1', platform: 'ios', udid: UDID, ref: '@e7', settle: true });
    const xy = await call(['press', '200', '300.5']);
    assert.equal(xy.reply.data.opts.x, 200);
    assert.equal(xy.reply.data.opts.y, 300.5);
    assert.equal(xy.reply.data.opts.settle, undefined);
    const lp = await call(['longpress', '10', '20', '800']);
    assert.equal(lp.reply.data.opts.durationMs, 800);
    const pan = await call(['gesture', 'pan', '200', '600', '0', '-300', '150']);
    assert.deepEqual([pan.reply.data.opts.x, pan.reply.data.opts.dy, pan.reply.data.opts.durationMs], [200, -300, 150]);
    const sw = await call(['swipe', '1', '2', '3', '4']);
    assert.deepEqual(sw.reply.data.opts.to, { x: 3, y: 4 });
    const snap = await call(['snapshot', '-i']);
    assert.equal(snap.reply.data.opts.interactiveOnly, true);
    const back = await call(['back', '--system']);
    assert.equal(back.reply.data.opts.mode, 'system');
    const kb = await call(['keyboard', 'enter']);
    assert.equal(kb.reply.data.opts.action, 'enter');
    const fill = await call(['fill', '@e2', 'hello', '--settle']);
    assert.deepEqual([fill.reply.data.opts.ref, fill.reply.data.opts.text], ['@e2', 'hello']);
    // an unmapped command and an unmapped gesture are `unsupported`
    assert.equal((await call(['record'])).unsupported, true);
    assert.equal((await call(['gesture', 'pinch', '1'])).unsupported, true);
    // a client error keeps its code, message, hint and reason in the CLI's error shape
    const bad = await call(['type', 'boom']);
    assert.equal(bad.reply.success, false);
    assert.deepEqual(bad.reply.error, {
      code: 'COMMAND_FAILED',
      message: 'Gesture trajectory does not fit',
      hint: 'h',
      details: { reason: 'r' },
    });
  } finally {
    p.stdin.end();
  }
  await new Promise((r) => p.on('close', r));
});

// ---------- the driver with a host ----------

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
  return { run, calls, cli: (cmd) => calls.filter((c) => new RegExp(`agent-device\\.mjs' '${cmd}'`).test(c.script)) };
}
const HELPER_PRESENT = [/test -f .*agent-device\.mjs/, ok('yes\n')];

/** A fake HelperHost: `answer(argv)` returns data, throws, or returns 'unsupported'. */
function fakeHost(answer) {
  const calls = [];
  // Like the real helper: a command other than `open` fails with SESSION_NOT_FOUND until the session was opened.
  let opened = false;
  return {
    calls,
    available: true,
    async call(argv) {
      calls.push(argv);
      if (argv[0] === 'open') opened = true;
      else if (!opened) return { unsupported: false, reply: JSON.stringify(ios.sessionNotFound) };
      const r = await answer(argv);
      return r === 'unsupported'
        ? { unsupported: true }
        : { unsupported: false, reply: JSON.stringify({ success: true, data: r }) };
    },
    async close() {},
  };
}

function hostDriver(answer, routes = []) {
  const host = fakeHost(answer);
  const r = fakeRunner([HELPER_PRESENT, ...routes]);
  const d = createDriver({ run: r.run, appDataDir: '/data/app', sleep: async () => {}, quietMs: 0, host });
  return { d, host, r };
}
const openOk = { message: 'Opened', appBundleId: 'com.apple.springboard' };

test('driver: iOS helper calls go through the host and start no node process', async () => {
  const { d, host, r } = hostDriver((argv) =>
    argv[0] === 'open' ? openOk : argv[0] === 'snapshot' ? ios.snapshot.data : {},
  );
  const map = await d.snapshot(UDID);
  assert.ok(map.nodes.length > 5);
  assert.equal(r.cli('snapshot').length + r.cli('open').length, 0);
  assert.deepEqual(
    host.calls.map((a) => a[0]),
    ['snapshot', 'open', 'snapshot'],
  );
  assert.deepEqual(host.calls[1].slice(-5), ['--udid', UDID, '--platform', 'ios', '--json']);
});

test('driver: a host that cannot start falls back to the CLI for that call', async () => {
  const host = {
    available: true,
    async call() {
      throw new HostError('no start', 'host-unavailable', false);
    },
    async close() {},
  };
  const r = fakeRunner([
    HELPER_PRESENT,
    [/'open'/, json({ success: true, data: openOk })],
    [/'snapshot'/, json(ios.snapshot)],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {}, host });
  assert.ok((await d.snapshot(UDID)).nodes.length > 5);
  assert.equal(r.cli('snapshot').length, 1);
});

test('driver: `unsupported` runs the CLI', async () => {
  const { d, r } = hostDriver(
    () => 'unsupported',
    [
      [/'open'/, json({ success: true, data: openOk })],
      [/'snapshot'/, json(ios.snapshot)],
    ],
  );
  await d.snapshot(UDID);
  assert.equal(r.cli('snapshot').length, 1);
});

test('driver: a host that died during a tap is NOT replayed through the CLI; a snapshot is', async () => {
  let mode = 'tap';
  const host = {
    available: true,
    async call(argv) {
      if (argv[0] === 'open') return { unsupported: false, reply: JSON.stringify({ success: true, data: openOk }) };
      if (argv[0] === 'press') throw new HostError('died', 'host-crashed', true);
      if (argv[0] === 'snapshot' && mode === 'snap') throw new HostError('died', 'host-crashed', true);
      return { unsupported: false, reply: JSON.stringify({ success: true, data: ios.snapshot.data }) };
    },
    async close() {},
  };
  const r = fakeRunner([
    HELPER_PRESENT,
    [/'open'/, json({ success: true, data: openOk })],
    [/'press'/, json({ success: true, data: {} })],
    [/'snapshot'/, json(ios.snapshot)],
  ]);
  const d = createDriver({ run: r.run, appDataDir: '/d', sleep: async () => {}, host });
  await assert.rejects(d.human.tap(UDID, { x: 10, y: 20 }), (e) => e.code === 'failed');
  assert.equal(r.cli('press').length, 0, 'the tap was not repeated');
  mode = 'snap';
  assert.ok((await d.snapshot(UDID)).nodes.length > 5);
  assert.equal(r.cli('snapshot').length, 1, 'a snapshot is harmless to repeat');
});

// ---------- the human path ----------

test('human input: no --settle, no snapshot before or after, empty diff; the agent path still settles and snapshots', async () => {
  const seen = [];
  const { d } = hostDriver((argv) => {
    seen.push(argv[0]);
    return argv[0] === 'open' ? openOk : argv[0] === 'snapshot' ? ios.snapshot.data : { message: 'Tapped' };
  });
  const res = await d.human.tap(UDID, { x: 200, y: 300 });
  assert.deepEqual(res, { message: 'Tapped', diff: '', settled: true });
  assert.deepEqual(seen, ['open', 'press'], 'one open to bind the session, then the tap: nothing else');
  seen.length = 0;
  await d.tap(UDID, { x: 200, y: 300 });
  assert.deepEqual(seen, ['snapshot', 'press', 'snapshot'], 'verified path: snapshot before, tap, snapshot after');
});

test('human input: swipe is a timed pan (80..400 ms), type/enter/home do not settle, order is kept', async () => {
  const argvs = [];
  const { d } = hostDriver((argv) => {
    argvs.push(argv);
    return argv[0] === 'open' ? openOk : { message: argv[0] };
  });
  await Promise.all([
    d.human.swipe(UDID, { x: 200, y: 600 }, { x: 200, y: 300 }, 30),
    d.human.swipe(UDID, { x: 200, y: 600 }, { x: 200, y: 300 }),
    d.human.swipe(UDID, { x: 200, y: 600 }, { x: 200, y: 300 }, 5000),
    d.human.type(UDID, 'abc'),
    d.human.press(UDID, 'enter'),
    d.human.press(UDID, 'home'),
  ]);
  const acts = argvs.filter((a) => a[0] !== 'open');
  assert.deepEqual(
    acts.map((a) => a[0]),
    ['gesture', 'gesture', 'gesture', 'type', 'type', 'home'],
    'strictly in call order',
  );
  assert.deepEqual(
    acts.slice(0, 3).map((a) => a[6]),
    ['80', '120', '400'],
  );
  assert.ok(!acts.some((a) => a.includes('--settle')));
});

test('background snapshot: skipped (last map returned) when an action was queued behind it before it started', async () => {
  let snaps = 0;
  let releaseTap;
  const { d } = hostDriver(async (argv) => {
    if (argv[0] === 'open') return openOk;
    if (argv[0] === 'snapshot') {
      snaps++;
      return ios.snapshot.data;
    }
    if (argv[0] === 'press') await new Promise((r) => (releaseTap = r));
    return { message: 'Tapped' };
  });
  const first = await d.snapshot(UDID); // fills the cache: snaps = 1
  const tap1 = d.human.tap(UDID, { x: 1, y: 1 }); // holds the device queue
  await tick(5);
  const bg = d.snapshot(UDID, { background: true }); // waits behind the tap
  const tap2 = d.human.tap(UDID, { x: 2, y: 2 }); // queued after the background snapshot: overtakes it in effect
  await tick(5);
  releaseTap();
  await tick(5);
  releaseTap?.();
  const map = await bg;
  await Promise.all([tap1, tap2]);
  assert.equal(map, first, 'the stale map was returned');
  assert.equal(snaps, 1, 'no snapshot was taken for the superseded background request');
});

test('background snapshot: runs normally when nothing overtakes it, and a waiting caller keeps a shared one alive', async () => {
  let snaps = 0;
  const { d } = hostDriver((argv) => {
    if (argv[0] === 'open') return openOk;
    snaps++;
    return ios.snapshot.data;
  });
  await d.snapshot(UDID, { background: true });
  assert.equal(snaps, 1);
});
