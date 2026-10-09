// The agent's device tools (src/agent/deviceCore.ts, deviceTools.ts) against the fake driver and the recorded iOS
// Settings snapshot: argument validation, the text agents read, device memory per chat, stale refs, approvals, who is
// offered the tools, Stop, and the agent-activity store.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const core = await import('../src/agent/deviceCore.ts');
const tools = await import('../src/agent/deviceTools.ts');
const { createFakeDriver } = await import('../src/device/fakeDriver.ts');
const { parseSnapshot } = await import('../src/device/uiMap.ts');
const { DeviceError } = await import('../src/device/types.ts');
const activity = await import('../src/device/agentActivity.ts');
const seam = await import('../src/device/driverSeam.ts');

const real = parseSnapshot(
  JSON.parse(readFileSync(new URL('./fixtures/device-ios-settings-snapshot.json', import.meta.url), 'utf8')),
);

beforeEach(() => {
  tools.resetDeviceMemory();
  activity.resetAgentActivity();
  seam.setDeviceDriver(undefined);
});

/** A context with a fake driver; `answers` are the approval answers in order (default: allow). */
function setup(o = {}) {
  const fake = createFakeDriver({ map: real, ...o.fake });
  const asked = [];
  const answers = [...(o.answers ?? [])];
  const ac = new AbortController();
  const ctx = {
    chatId: o.chatId ?? 1,
    signal: ac.signal,
    askFirst: o.askFirst ?? true,
    approve: async (req) => {
      asked.push(req);
      return answers.length ? answers.shift() : true;
    },
    driver: () => o.driver ?? fake.driver,
    sleep: async () => {},
  };
  const run = (name, args = {}) => tools.runDeviceTool(name, args, ctx);
  return { fake, asked, ctx, ac, run };
}

// ---- definitions and validation ----

test('every tool has a definition with strict parameters, and the names match', () => {
  assert.deepEqual(
    core.DEVICE_TOOLS.map((t) => t.name),
    [...core.DEVICE_TOOL_NAMES],
  );
  for (const t of core.DEVICE_TOOLS) {
    assert.equal(t.parameters.additionalProperties, false, t.name);
    assert.ok(t.description.length > 20, t.name);
    assert.equal(core.isDeviceTool(t.name), true);
  }
  assert.equal(core.isDeviceTool('read_file'), false);
});

test('valid calls parse into normalised commands', () => {
  const p = (n, a) => core.parseDeviceCall(n, a);
  assert.deepEqual(p('device_tap', { ref: '@e7' }), { ok: true, call: { tool: 'device_tap', target: { ref: 'e7' } } });
  assert.deepEqual(p('device_tap', { ref: 'e7', device: ' SIM-1 ' }).call, {
    tool: 'device_tap',
    device: 'SIM-1',
    target: { ref: 'e7' },
  });
  assert.deepEqual(p('device_tap', { x: 10, y: 20.5 }).call.target, { x: 10, y: 20.5 });
  assert.deepEqual(p('device_long_press', { ref: 'e1', ms: 900 }).call, {
    tool: 'device_long_press',
    target: { ref: 'e1' },
    ms: 900,
  });
  assert.deepEqual(p('device_swipe', { from_x: 1, from_y: 2, to_x: 3, to_y: 4 }).call, {
    tool: 'device_swipe',
    from: { x: 1, y: 2 },
    to: { x: 3, y: 4 },
  });
  assert.deepEqual(p('device_fill', { ref: 'e19', text: '' }).call, {
    tool: 'device_fill',
    target: { ref: 'e19' },
    text: '',
  });
  assert.deepEqual(p('device_scroll', { direction: 'down', amount: 0.5 }).call, {
    tool: 'device_scroll',
    direction: 'down',
    amount: 0.5,
  });
  assert.deepEqual(p('device_close', {}).call, { tool: 'device_close', shutdown: false });
  assert.deepEqual(p('device_snapshot', undefined).call, { tool: 'device_snapshot', screenshot: false });
});

test('invalid arguments are errors with a reason, never exceptions', () => {
  const bad = (n, a, re) => {
    const r = core.parseDeviceCall(n, a);
    assert.equal(r.ok, false, `${n} ${JSON.stringify(a)}`);
    assert.match(r.error, re, `${n} ${JSON.stringify(a)}`);
  };
  bad('device_nope', {}, /Unknown device tool/);
  bad('device_tap', 'x', /object/);
  bad('device_tap', [], /object/);
  bad('device_tap', {}, /ref .* or x and y/i);
  bad('device_tap', { ref: 'e1', x: 1, y: 2 }, /not both/);
  bad('device_tap', { x: 1 }, /together/);
  bad('device_tap', { x: '1', y: 2 }, /number/);
  bad('device_tap', { x: NaN, y: 2 }, /number/);
  bad('device_tap', { x: -1, y: 2 }, /between/);
  bad('device_tap', { x: 1e9, y: 2 }, /between/);
  bad('device_tap', { ref: 5 }, /string/);
  bad('device_tap', { ref: 'e1; rm -rf /' }, /not an element ref/);
  bad('device_tap', { ref: 'e1', extra: 1 }, /Unknown argument: extra/);
  bad('device_tap', { ref: 'e1', device: 5 }, /device must be a string/);
  bad('device_tap', { ref: 'e1', device: 'a\nb' }, /control/);
  bad('device_tap', { ref: 'e1', device: 'x'.repeat(201) }, /too long/);
  bad('device_long_press', { ref: 'e1', ms: 10 }, /between 50 and 10000/);
  bad('device_long_press', { ref: 'e1', ms: 1.5 }, /whole number/);
  bad('device_swipe', { from_x: 1, from_y: 1, to_x: 1, to_y: 1 }, /different/);
  bad('device_swipe', { from_x: 1, from_y: 1, to_x: 2 }, /to_y/);
  bad('device_swipe', { from_x: 1, from_y: 1, to_x: 2, to_y: 2, ms: 9999 }, /between 50 and 5000/);
  bad('device_type', {}, /text/);
  bad('device_type', { text: '' }, /empty/);
  bad('device_type', { text: 'x'.repeat(core.MAX_TEXT + 1) }, /too long/);
  bad('device_type', { text: 'a\u0000b' }, /NUL/);
  bad('device_fill', { ref: 'e1' }, /text/);
  bad('device_press', { key: 'power' }, /one of/);
  bad('device_scroll', { direction: 'sideways' }, /one of/);
  bad('device_scroll', { direction: 'up', amount: 5 }, /between 0.05 and 0.8/);
  bad('device_open_app', {}, /app is required/);
  bad('device_open_app', { app: '-h' }, /option/);
  bad('device_open_app', { app: '/Applications/X' }, /path or command/);
  bad('device_open_app', { app: 'a; reboot' }, /path or command/);
  bad('device_snapshot', { screenshot: 'yes' }, /true or false/);
  bad('device_close', { shutdown: 1 }, /true or false/);
  bad('device_list', { device: 'x' }, /Unknown argument/);
});

test('text at the cap is accepted (counted in characters)', () => {
  assert.equal(core.parseDeviceCall('device_type', { text: 'я'.repeat(core.MAX_TEXT) }).ok, true);
});

test('points must be inside the screen', () => {
  const screen = { width: 402, height: 874 };
  const tap = (x, y) => core.parseDeviceCall('device_tap', { x, y }).call;
  assert.equal(core.pointError(tap(401, 873), screen), null);
  assert.match(core.pointError(tap(402, 10), screen), /outside the screen \(402x874 points\)/);
  assert.match(core.pointError(tap(10, 900), screen), /outside the screen/);
  const sw = core.parseDeviceCall('device_swipe', { from_x: 1, from_y: 1, to_x: 500, to_y: 5 }).call;
  assert.match(core.pointError(sw, screen), /outside/);
  assert.equal(core.pointError(core.parseDeviceCall('device_tap', { ref: 'e1' }).call, screen), null);
});

test('call descriptions for cards and the action log', () => {
  const d = core.describeDeviceCall;
  assert.equal(d('device_tap', { ref: 'e7' }), 'tap @e7');
  assert.equal(d('device_tap', { ref: '@e7' }), 'tap @e7');
  assert.equal(d('device_tap', { x: 10, y: 20 }), 'tap 10,20');
  assert.equal(d('device_long_press', { ref: 'e2' }), 'long-press @e2');
  assert.equal(d('device_swipe', { from_x: 200, from_y: 600, to_x: 200, to_y: 200 }), 'swipe 200,600 → 200,200');
  assert.equal(d('device_type', { text: 'hello\nworld' }), 'type "hello world"');
  assert.equal(d('device_fill', { ref: 'e19', text: 'x'.repeat(100) }).length < 70, true);
  assert.equal(d('device_snapshot', { screenshot: true }), 'snapshot + screenshot');
  assert.equal(d('device_close', { shutdown: true }), 'shut down device');
  assert.equal(d('device_tap', { ref: 'e7', device: 'iPhone 17 Pro' }), 'tap @e7 · iPhone 17 Pro');
  assert.equal(d('device_tap', null), 'tap ?,?');
});

// ---- tools against the fake driver ----

test('device_list shows the devices and marks the current one', async () => {
  const { run } = setup();
  let out = (await run('device_list')).output;
  assert.match(out, /iPhone 17 Pro · ios 26\.2 · booted · id SIM-1/);
  assert.match(out, /iPhone 16e .* shutdown/);
  assert.doesNotMatch(out, /\* /);
  await run('device_open', { device: 'SIM-1' });
  out = (await run('device_list')).output;
  assert.match(out, /^\* iPhone 17 Pro/m);
});

test('device_list tells what to do when there is no device', async () => {
  const { run } = setup({ fake: { devices: [] } });
  assert.match((await run('device_list')).output, /No simulators or emulators found/);
});

test('device_open boots a stopped device, remembers it, and later calls may omit device', async () => {
  const { run, fake } = setup();
  const r = await run('device_open', { device: 'iphone 16e' });
  assert.match(r.output, /Using iPhone 16e \(iOS 26\.2\) \(id SIM-2\)/);
  assert.deepEqual(
    fake.calls.filter((c) => c.method === 'boot'),
    [{ method: 'boot', args: ['SIM-2'] }],
  );
  assert.equal(tools.currentDeviceOf(1), 'SIM-2');
  await run('device_snapshot');
  await run('device_press', { key: 'home' });
  assert.deepEqual(
    fake.calls.filter((c) => c.method === 'press'),
    [{ method: 'press', args: ['SIM-2', 'home'] }],
  );
});

test('device_open of a booted device does not boot it', async () => {
  const { run, fake } = setup();
  await run('device_open', { device: 'SIM-1' });
  assert.equal(
    fake.calls.some((c) => c.method === 'boot'),
    false,
  );
});

test('device_open without device picks the only booted one, otherwise asks the agent to choose', async () => {
  const one = setup();
  assert.match((await one.run('device_open')).output, /id SIM-1/);
  const two = setup({
    fake: {
      devices: [
        { id: 'A', name: 'Pixel', platform: 'android', state: 'booted' },
        { id: 'B', name: 'iPhone', platform: 'ios', state: 'booted' },
      ],
    },
  });
  await assert.rejects(two.run('device_open'), /Say which device to open[\s\S]*Pixel[\s\S]*iPhone/);
});

test('a device name matching several devices is an error that lists them', async () => {
  const { run } = setup({
    fake: {
      devices: [
        { id: 'A', name: 'iPhone 17', platform: 'ios', state: 'booted' },
        { id: 'B', name: 'iPhone 17 Pro', platform: 'ios', state: 'booted' },
      ],
    },
  });
  await assert.rejects(run('device_open', { device: 'iphone' }), /matches several devices[\s\S]*id A[\s\S]*id B/);
  assert.match((await run('device_open', { device: 'iPhone 17' })).output, /id A/); // exact name wins
  await assert.rejects(run('device_open', { device: 'galaxy' }), /No device matches "galaxy"/);
});

test('without an opened device, tools ask for device_open; the only booted device is used', async () => {
  const two = setup({
    fake: {
      devices: [
        { id: 'A', name: 'Pixel', platform: 'android', state: 'booted' },
        { id: 'B', name: 'iPhone', platform: 'ios', state: 'booted' },
      ],
    },
  });
  await assert.rejects(two.run('device_snapshot'), /No device is selected\. Call device_open/);
  const one = setup();
  assert.match((await one.run('device_snapshot')).output, /iPhone 17 Pro/);
});

test('device memory is per chat', async () => {
  const a = setup({ chatId: 10 });
  await a.run('device_open', { device: 'SIM-2' });
  assert.equal(tools.currentDeviceOf(10), 'SIM-2');
  assert.equal(tools.currentDeviceOf(11), undefined);
  // The other chat starts without a choice; with one booted device it falls back to that one.
  const b = setup({ chatId: 11 });
  await b.run('device_press', { key: 'home' });
  assert.deepEqual(b.fake.calls.find((c) => c.method === 'press').args, ['SIM-1', 'home']);
  tools.resetDeviceMemory(10);
  assert.equal(tools.currentDeviceOf(10), undefined);
});

test('a remembered device that disappeared is forgotten', async () => {
  const { run, fake } = setup();
  await run('device_open', { device: 'SIM-2' });
  fake.devices.splice(1, 1);
  await run('device_press', { key: 'back' });
  assert.equal(tools.currentDeviceOf(1), 'SIM-1');
});

test('device_snapshot returns the map with refs; a screenshot is attached on request', async () => {
  const { run, fake } = setup();
  const r = await run('device_snapshot');
  assert.match(r.output, /^iPhone 17 Pro \(iOS 26\.2\)\nSettings \(com\.apple\.Preferences\) 402x874/);
  assert.match(r.output, /@e7 \[cell\] "Основные" id=com\.apple\.settings\.general/);
  assert.equal(r.image, undefined);
  assert.equal(
    fake.calls.some((c) => c.method === 'frame'),
    false,
  );
  const s = await run('device_snapshot', { screenshot: true });
  assert.equal(s.image, 'iVBORw0KGgo=');
});

test('a JPEG frame is not attached (providers declare images as PNG)', async () => {
  const fake = createFakeDriver({ map: real });
  const driver = { ...fake.driver, frame: async () => ({ ...(await fake.driver.frame('SIM-1')), mime: 'image/jpeg' }) };
  const { run } = setup({ driver });
  const r = await run('device_snapshot', { screenshot: true });
  assert.equal(r.image, undefined);
  assert.match(r.output, /returned a JPEG/);
});

test('an action returns the driver message and the screen diff', async () => {
  const fake = createFakeDriver({ map: real });
  const diff =
    '1 removed, 1 added, 0 changed, 12 unchanged\n- @e7 [cell] "Основные"\n+ @e30 [cell] "Об этом устройстве"';
  const driver = { ...fake.driver, tap: async () => ({ message: 'Tapped @e7 (201, 355)', diff, settled: true }) };
  const { run } = setup({ driver });
  await run('device_snapshot');
  const r = await run('device_tap', { ref: '@e7' });
  assert.match(r.output, /^Tapped @e7 \(201, 355\)\nScreen changed:\n1 removed, 1 added/);
  assert.match(r.output, /\+ @e30 \[cell\]/);
  assert.match(r.output, /Refs from before this action may be stale/);
});

test('an action without a visible change says so; an unsettled screen asks for a snapshot', async () => {
  const fake = createFakeDriver({ map: real });
  const { run } = setup({
    driver: { ...fake.driver, press: async () => ({ message: 'Pressed home', diff: '', settled: false }) },
  });
  const r = await run('device_press', { key: 'home' });
  assert.match(r.output, /^Pressed home\nNo visible change on screen\.\nThe screen was still changing/);
});

test('every action tool reaches the driver with the right arguments', async () => {
  const { run, fake } = setup();
  await run('device_snapshot');
  await run('device_tap', { ref: 'e7' });
  await run('device_tap', { x: 100, y: 200 });
  await run('device_long_press', { ref: 'e7', ms: 700 });
  await run('device_swipe', { from_x: 200, from_y: 600, to_x: 200, to_y: 200, ms: 300 });
  await run('device_type', { text: 'hi' });
  await run('device_fill', { ref: 'e19', text: 'wifi' });
  await run('device_press', { key: 'enter' });
  await run('device_scroll', { direction: 'down', amount: 0.5 });
  await run('device_open_app', { app: 'com.apple.Preferences' });
  const seen = fake.calls.filter((c) => c.method !== 'list' && c.method !== 'snapshot');
  assert.deepEqual(seen, [
    { method: 'tap', args: ['SIM-1', { ref: 'e7' }] },
    { method: 'tap', args: ['SIM-1', { x: 100, y: 200 }] },
    { method: 'longPress', args: ['SIM-1', { ref: 'e7' }, 700] },
    { method: 'swipe', args: ['SIM-1', { x: 200, y: 600 }, { x: 200, y: 200 }, 300] },
    { method: 'type', args: ['SIM-1', 'hi'] },
    { method: 'fill', args: ['SIM-1', { ref: 'e19' }, 'wifi'] },
    { method: 'press', args: ['SIM-1', 'enter'] },
    { method: 'scroll', args: ['SIM-1', 'down', 0.5] },
    { method: 'openApp', args: ['SIM-1', 'com.apple.Preferences'] },
  ]);
});

test('stale refs: no snapshot yet, a ref that is not in the latest snapshot, and a driver stale-ref error', async () => {
  const { run } = setup();
  await assert.rejects(run('device_tap', { ref: 'e7' }), /call device_snapshot first/);
  await run('device_snapshot');
  await assert.rejects(
    run('device_tap', { ref: 'e999' }),
    /not in the latest snapshot\. That element ref is no longer valid.*new device_snapshot/,
  );
  const fake = createFakeDriver({ map: real });
  const driver = {
    ...fake.driver,
    tap: async () => {
      throw new DeviceError('ref e7 expired', 'stale-ref');
    },
  };
  const s = setup({ driver });
  await s.run('device_snapshot');
  await assert.rejects(s.run('device_tap', { ref: 'e7' }), /no longer valid[\s\S]*device_snapshot/);
  // The cached map is dropped: the next ref use needs a fresh snapshot.
  await assert.rejects(s.run('device_tap', { ref: 'e7' }), /call device_snapshot first/);
});

test('other driver failures are tool errors with the driver message', async () => {
  const { run, fake } = setup();
  fake.state.failNext = 'adb: device offline';
  await assert.rejects(run('device_press', { key: 'home' }), /adb: device offline/);
});

test('coordinates outside the screen are rejected before the driver is called', async () => {
  const { run, fake } = setup();
  await assert.rejects(run('device_tap', { x: 500, y: 10 }), /outside the screen \(402x874 points\)/);
  await run('device_snapshot');
  await assert.rejects(run('device_swipe', { from_x: 1, from_y: 1, to_x: 10, to_y: 2000 }), /outside the screen/);
  assert.equal(
    fake.calls.some((c) => c.method === 'tap' || c.method === 'swipe'),
    false,
  );
});

test('invalid arguments never reach the driver', async () => {
  const { run, fake } = setup();
  await assert.rejects(run('device_type', { text: 'x'.repeat(5000) }), /too long/);
  assert.equal(fake.calls.length, 0);
});

test('a missing driver is a tool error', async () => {
  const ac = new AbortController();
  await assert.rejects(
    tools.runDeviceTool('device_list', {}, { signal: ac.signal, askFirst: false, approve: async () => true }),
    /Device driver not available/,
  );
  const fake = createFakeDriver();
  seam.setDeviceDriver(fake.driver);
  assert.match(
    (await tools.runDeviceTool('device_list', {}, { signal: ac.signal, askFirst: false, approve: async () => true }))
      .output,
    /SIM-1/,
  );
});

test('device_close releases the session; shutdown powers off; both forget the device', async () => {
  const { run, fake } = setup({ askFirst: false, answers: [true] });
  await run('device_open', { device: 'SIM-1' });
  assert.match((await run('device_close')).output, /Closed the automation session with iPhone 17 Pro/);
  assert.deepEqual(
    fake.calls.filter((c) => c.method === 'release'),
    [{ method: 'release', args: ['SIM-1'] }],
  );
  assert.equal(tools.currentDeviceOf(1), undefined);
  assert.match((await run('device_close', { device: 'SIM-1', shutdown: true })).output, /powered off/);
  assert.equal(fake.devices[0].state, 'shutdown');
});

// ---- approvals ----

test('the first device action in a chat asks, naming the device; later ones do not', async () => {
  const { run, asked } = setup();
  await run('device_open', { device: 'SIM-1' });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'device');
  assert.equal(asked[0].device, 'iPhone 17 Pro (iOS 26.2)');
  assert.match(asked[0].text, /iPhone 17 Pro/);
  assert.equal(asked[0].destructive, undefined);
  await run('device_snapshot');
  await run('device_tap', { x: 5, y: 5 });
  assert.equal(asked.length, 1);
});

test('approval is per chat and per device', async () => {
  const a = setup({ chatId: 20 });
  await a.run('device_open', { device: 'SIM-1' });
  const b = setup({ chatId: 21 });
  await b.run('device_open', { device: 'SIM-1' });
  assert.equal(a.asked.length + b.asked.length, 2);
  await a.run('device_open', { device: 'SIM-2' });
  assert.equal(a.asked.length, 2);
  assert.match(a.asked[1].text, /will be started first/);
});

test('a declined first use blocks the call and asks again next time', async () => {
  const { run, fake, asked } = setup({ answers: [false, true] });
  await assert.rejects(run('device_open', { device: 'SIM-2' }), tools.DeviceDeclined);
  assert.equal(
    fake.calls.some((c) => c.method === 'boot'),
    false,
  );
  assert.equal(tools.currentDeviceOf(1), undefined);
  await run('device_open', { device: 'SIM-2' });
  assert.equal(asked.length, 2);
});

test('with first-use asking off nothing is asked, except for shutting a device down', async () => {
  const { run, asked, fake } = setup({ askFirst: false, answers: [false] });
  await run('device_open', { device: 'SIM-1' });
  await run('device_tap', { x: 1, y: 1 });
  assert.equal(asked.length, 0);
  await assert.rejects(run('device_close', { shutdown: true }), tools.DeviceDeclined);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].destructive, true);
  assert.match(asked[0].text, /Power off iPhone 17 Pro/);
  assert.equal(fake.devices[0].state, 'booted');
});

test('shutdown asks every time, even after the device was allowed', async () => {
  const { run, asked } = setup();
  await run('device_open', { device: 'SIM-1' });
  await run('device_close', { shutdown: true });
  await run('device_open', { device: 'SIM-1' });
  await run('device_close', { shutdown: true });
  assert.equal(asked.filter((r) => r.destructive).length, 2);
});

// ---- who gets the tools ----

const base = { enabled: true, access: 'auto' };
test('access OFF hides the tools from everybody', () => {
  assert.equal(core.deviceToolsEligible({ ...base, enabled: false }), false);
  assert.equal(core.deviceToolsEligible({ ...base, enabled: false, optIn: true }), false);
  assert.equal(core.deviceToolsEligible(base), true);
});

test('only agent mode with writable access is offered the tools', () => {
  assert.equal(core.deviceToolsEligible({ ...base, mode: 'agent' }), true);
  assert.equal(core.deviceToolsEligible({ ...base, mode: 'plan' }), false);
  assert.equal(core.deviceToolsEligible({ ...base, mode: 'ask' }), false);
  assert.equal(core.deviceToolsEligible({ ...base, access: 'readonly' }), false);
  assert.equal(core.deviceToolsEligible({ ...base, access: 'full' }), true);
});

test('subagents, scheduled and mobile runs never get the tools unless the call site opts in', () => {
  assert.equal(core.deviceToolsEligible({ ...base, subagent: true }), false);
  assert.equal(core.deviceToolsEligible({ ...base, toolNames: ['read_file'] }), false);
  assert.equal(core.deviceToolsEligible({ ...base, source: 'scheduled' }), false);
  assert.equal(core.deviceToolsEligible({ ...base, source: 'scheduled', optIn: true }), true);
  // Read-only and Plan still win over an opt-in.
  assert.equal(core.deviceToolsEligible({ ...base, subagent: true, optIn: true, access: 'readonly' }), false);
  assert.equal(core.deviceToolsEligible({ ...base, subagent: true, optIn: true, mode: 'plan' }), false);
});

test('the subagent tool sets contain no device tool', async () => {
  const { TYPE_TOOLS } = await import('../src/agent/subagentCore.ts');
  for (const names of Object.values(TYPE_TOOLS))
    for (const n of names ?? []) assert.equal(core.isDeviceTool(n), false, n);
});

test('settings normalise to the safe defaults', async () => {
  const s = await import('../src/agent/deviceSettings.ts');
  assert.deepEqual(s.DEFAULT_DEVICE_SETTINGS, { access: false, askFirst: true });
  assert.deepEqual(s.normalizeDeviceSettings(null), { access: false, askFirst: true });
  assert.deepEqual(s.normalizeDeviceSettings({ access: 'true', askFirst: 0 }), { access: false, askFirst: true });
  assert.deepEqual(s.normalizeDeviceSettings({ access: true, askFirst: false }), { access: true, askFirst: false });
});

// ---- Stop ----

test('Stop aborts an in-flight driver call at once', async () => {
  const fake = createFakeDriver({ map: real });
  let finish;
  const hung = new Promise((r) => (finish = r));
  const driver = { ...fake.driver, tap: () => hung };
  const { run, ac } = setup({ driver });
  await run('device_snapshot');
  const call = run('device_tap', { x: 1, y: 1 });
  setTimeout(() => ac.abort(), 5);
  await assert.rejects(call, (e) => e.name === 'AbortError');
  finish({ message: 'late', diff: '', settled: true }); // the late result is ignored without an unhandled rejection
});

test('a call made after Stop does not touch the driver; Stop also ends a pending approval', async () => {
  const s = setup();
  s.ac.abort();
  await assert.rejects(s.run('device_snapshot'), (e) => e.name === 'AbortError');
  assert.equal(s.fake.calls.length, 0);
  const pending = setup();
  pending.ctx.approve = () => new Promise(() => {});
  const call = pending.run('device_open', { device: 'SIM-1' });
  setTimeout(() => pending.ac.abort(), 5);
  await assert.rejects(call, (e) => e.name === 'AbortError');
});

// ---- agent activity store ----

test('activity is set when a device tool starts and cleared on request', async () => {
  const seen = [];
  const off = activity.subscribeAgentActivity(() => seen.push(activity.getAgentActivity().length));
  const { run } = setup({ chatId: 7 });
  assert.deepEqual(activity.getAgentActivity(), []);
  await run('device_open', { device: 'SIM-1' });
  let [a] = activity.getAgentActivity();
  assert.equal(a.chatId, 7);
  assert.equal(a.deviceId, 'SIM-1');
  assert.equal(a.name, 'iPhone 17 Pro (iOS 26.2)');
  assert.equal(a.tool, 'device_open');
  const since = a.since;
  await run('device_press', { key: 'home' });
  [a] = activity.getAgentActivity();
  assert.equal(a.tool, 'device_press');
  assert.equal(a.since, since); // same device: the banner keeps its start time
  assert.equal(activity.agentActivityFor('SIM-1').chatId, 7);
  assert.equal(activity.agentActivityFor('SIM-2'), undefined);
  activity.clearAgentDevice(8); // another chat: no change
  assert.equal(activity.getAgentActivity().length, 1);
  activity.clearAgentDevice(7);
  assert.deepEqual(activity.getAgentActivity(), []);
  off();
  assert.deepEqual(seen, [1, 1, 0]);
});

test('activity keeps one entry per chat and a stable array while nothing changes', () => {
  activity.setAgentDevice({ chatId: 1, deviceId: 'A', name: 'A', tool: 'device_tap' }, 100);
  activity.setAgentDevice({ chatId: 2, deviceId: 'B', name: 'B', tool: 'device_tap' }, 200);
  const first = activity.getAgentActivity();
  activity.setAgentDevice({ chatId: 1, deviceId: 'A', name: 'A', tool: 'device_tap' }, 300);
  assert.equal(activity.getAgentActivity(), first);
  activity.setAgentDevice({ chatId: 1, deviceId: 'C', name: 'C', tool: 'device_tap' }, 400);
  assert.equal(activity.getAgentActivity().length, 2);
  assert.equal(activity.agentActivityFor('C').since, 400);
  assert.equal(activity.agentActivityFor('A'), undefined);
});

test('the driver seam throws until a driver is installed', () => {
  assert.throws(() => seam.getDeviceDriver(), /Device driver not available/);
  assert.equal(seam.hasDeviceDriver(), false);
  const fake = createFakeDriver();
  seam.setDeviceDriver(fake.driver);
  assert.equal(seam.getDeviceDriver(), fake.driver);
});

test('refs listed in an action diff can be used without another snapshot', async () => {
  const fake = createFakeDriver({ map: real });
  const diff =
    '1 removed, 1 added, 0 changed, 12 unchanged\n- @e7 [cell] "Основные"\n+ @e30 [cell] "Об этом устройстве"';
  const driver = { ...fake.driver, tap: async () => ({ message: 'Tapped', diff, settled: true }) };
  const { run } = setup({ driver });
  await run('device_snapshot');
  await run('device_tap', { ref: 'e7' });
  await run('device_tap', { ref: '@e30' });
  assert.equal(
    fake.calls.some((c) => c.method === 'tap'),
    false,
  ); // the wrapped driver handled both
  await assert.rejects(run('device_tap', { ref: 'e31' }), /not in the latest snapshot/);
});
