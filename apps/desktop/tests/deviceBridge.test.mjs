// The app side of the gustaf-device command (src/agent/deviceBridge.ts) with the fake driver: tokens, when requests are
// served, the text a CLI agent prints, approvals, Stop and the audit hook.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { createDeviceBridge, cliWording } = await import('../src/agent/deviceBridge.ts');
const { runDeviceTool, resetDeviceMemory } = await import('../src/agent/deviceTools.ts');
const { createFakeDriver } = await import('../src/device/fakeDriver.ts');
const { parseSnapshot } = await import('../src/device/uiMap.ts');
const { resetAgentActivity } = await import('../src/device/agentActivity.ts');

const real = parseSnapshot(
  JSON.parse(readFileSync(new URL('./fixtures/device-ios-settings-snapshot.json', import.meta.url), 'utf8')),
);

let fake;
beforeEach(() => {
  fake = createFakeDriver({ map: real });
  resetDeviceMemory();
  resetAgentActivity();
});

function setup(o = {}) {
  const audit = [];
  const bridge = createDeviceBridge({
    settings: async () => ({ access: o.access ?? true, askFirst: true }),
    run: (name, args, ctx) => runDeviceTool(name, args, { ...ctx, driver: () => fake.driver, sleep: async () => {} }),
    audit: (tool, summary) => {
      const entry = { tool, summary };
      audit.push(entry);
      return (status, detail) => Object.assign(entry, { status, detail });
    },
  });
  const ac = new AbortController();
  const asked = [];
  const turn = { signal: ac.signal, askFirst: true, approve: async (req) => (asked.push(req), o.answer ?? true) };
  const token = bridge.tokenFor(3);
  const end = bridge.beginTurn(3, turn);
  const call = (...argv) => bridge.handle({ id: 1, token, argv });
  return { bridge, ac, asked, audit, token, end, call };
}

test('tokens are random, stable per chat and different between chats', () => {
  const { bridge, token } = setup();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(bridge.tokenFor(3), token);
  assert.notEqual(bridge.tokenFor(4), token);
});

test('requests with an unknown token are refused', async () => {
  const { bridge } = setup();
  const r = await bridge.handle({ id: 1, token: 'nope', argv: ['list'] });
  assert.equal(r.ok, false);
  assert.match(r.text, /unknown session/);
  assert.equal(fake.calls.length, 0);
});

test('access OFF refuses even with a valid token', async () => {
  const { call } = setup({ access: false });
  const r = await call('list');
  assert.equal(r.ok, false);
  assert.match(r.text, /access is off/);
  assert.equal(fake.calls.length, 0);
});

test('requests are served only while the chat has an active agent run', async () => {
  const { call, end, ac } = setup();
  assert.equal((await call('list')).ok, true);
  end();
  assert.match((await call('list')).text, /no agent run is active/);
  const again = setup();
  again.ac.abort();
  assert.match((await again.call('list')).text, /no agent run is active/);
  void ac;
});

test('a parse error prints the reason and the usage', async () => {
  const { call, audit } = setup();
  const r = await call('tapp');
  assert.equal(r.ok, false);
  assert.match(r.text, /^gustaf-device: Unknown command "tapp"\.\n\nUsage: gustaf-device/);
  assert.equal(audit.length, 0);
  assert.equal(fake.calls.length, 0);
});

test('commands print the same text as the tools, in command wording', async () => {
  const { call } = setup();
  const list = await call('list');
  assert.match(list.text, /iPhone 17 Pro · ios 26\.2 · booted · id SIM-1/);
  const open = await call('open', '--device', 'SIM-1');
  assert.equal(open.ok, true);
  assert.match(open.text, /Using iPhone 17 Pro .*Call gustaf-device snapshot to see the screen\./);
  const snap = await call('snapshot');
  assert.match(snap.text, /@e7 \[cell\] "Основные" id=com\.apple\.settings\.general/);
  const tap = await call('tap', '@e7');
  assert.match(tap.text, /^Tapped\nNo visible change on screen\./);
  assert.deepEqual(fake.calls.find((c) => c.method === 'tap').args, ['SIM-1', { ref: 'e7' }]);
});

test('errors name commands, not tools', async () => {
  const { call } = setup();
  const r = await call('tap', '@e7');
  assert.equal(r.ok, false);
  assert.match(r.text, /call gustaf-device snapshot first/);
  assert.doesNotMatch(r.text, /device_snapshot/);
});

test('snapshot --screenshot returns the image for the launcher to save', async () => {
  const { call } = setup();
  await call('open', '--device', 'SIM-1');
  const r = await call('snapshot', '--screenshot');
  assert.equal(r.image, 'iVBORw0KGgo=');
});

test('the first use asks through the chat approval card; a "no" is reported and not retried', async () => {
  const yes = setup();
  await yes.call('open', '--device', 'SIM-1');
  await yes.call('snapshot');
  assert.equal(yes.asked.length, 1);
  assert.equal(yes.asked[0].kind, 'device');
  resetDeviceMemory();
  const no = setup({ answer: false });
  const r = await no.call('open', '--device', 'SIM-2');
  assert.equal(r.ok, false);
  assert.match(r.text, /declined.*Do not retry/);
  assert.equal(
    fake.calls.some((c) => c.method === 'boot'),
    false,
  );
});

test('Stop ends an in-flight command', async () => {
  const s = setup();
  await s.call('open', '--device', 'SIM-1');
  fake.driver.press = () => new Promise(() => {});
  const pending = s.call('press', 'home');
  setTimeout(() => s.ac.abort(), 5);
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.text, /Stopped by the user/);
});

test('calls are written to the action log hook with their outcome', async () => {
  const { call, audit } = setup();
  await call('open', '--device', 'SIM-1');
  await call('press', 'home');
  fake.state.failNext = 'adb offline';
  await call('press', 'back');
  assert.deepEqual(
    audit.map((a) => [a.tool, a.summary, a.status]),
    [
      ['device_open', 'open SIM-1', 'success'],
      ['device_press', 'press home', 'success'],
      ['device_press', 'press back', 'error'],
    ],
  );
  assert.match(audit[2].detail, /adb offline/);
});

test('cliWording only rewrites exact tool names', () => {
  assert.equal(
    cliWording('Call device_open_app, then device_snapshot.'),
    'Call gustaf-device open-app, then gustaf-device snapshot.',
  );
  assert.equal(cliWording('device_id and my_device_snapshot2 stay'), 'device_id and my_device_snapshot2 stay');
});
