// The device tools inside the real agent loop (src/agent/agent.ts) with a scripted model and the fake driver: who is
// offered the tools, approvals, the result the model gets back, Stop, the action log and the agent-activity store.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { runAgent } = await import('../src/agent/agent.ts');
const { saveDeviceSettings, resetDeviceSettings } = await import('../src/agent/deviceSettingsStore.ts');
const { DEVICE_TOOL_NAMES, DEVICE_PROMPT } = await import('../src/agent/deviceCore.ts');
const { resetDeviceMemory } = await import('../src/agent/deviceTools.ts');
const { clearActionLog, getActionLog } = await import('../src/agent/actionLogStore.ts');
const { createFakeDriver } = await import('../src/device/fakeDriver.ts');
const { parseSnapshot } = await import('../src/device/uiMap.ts');
const { setDeviceDriver } = await import('../src/device/driverSeam.ts');
const activity = await import('../src/device/agentActivity.ts');

const real = parseSnapshot(
  JSON.parse(readFileSync(new URL('./fixtures/device-ios-settings-snapshot.json', import.meta.url), 'utf8')),
);
let n = 0;
const call = (name, args) => ({ type: 'tool_call', id: `d${n++}`, name, args });
const step = (...calls) => ({ parts: calls });

let fake;
beforeEach(() => {
  state.reset();
  clearActionLog();
  resetDeviceSettings();
  resetDeviceMemory();
  activity.resetAgentActivity();
  fake = createFakeDriver({ map: real });
  setDeviceDriver(fake.driver);
});
const enable = (over = {}) => saveDeviceSettings({ access: true, askFirst: true, ...over });

async function run(script, o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'device-agent-'));
  const ctl = new AbortController();
  const approvals = [];
  const results = [];
  const offered = [];
  const systems = [];
  let i = 0;
  const adapter = {
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      offered.push(input.tools.map((t) => t.name));
      systems.push(input.system);
      const next = script[i++];
      if (typeof next === 'function') return next({ ctl, input });
      return next ?? { parts: [{ type: 'text', text: 'done' }] };
    },
  };
  const promise = runAgent({
    root,
    chatId: o.chatId ?? 5,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter,
    providerId: 'p',
    model: 'm',
    access: o.access ?? 'auto',
    computerUse: false,
    allowlist: [],
    signal: ctl.signal,
    onText: () => {},
    onMessage: async (m) => {
      if (m.role === 'tool') results.push(...m.parts);
    },
    approve: async (req) => {
      approvals.push(req);
      return o.approve ? o.approve(req, ctl) : true;
    },
    ...(o.run ?? {}),
  });
  if (o.concurrent) await o.concurrent(ctl);
  await promise.catch((e) => {
    if (!o.expectError) throw e;
  });
  return { results, approvals, offered, systems, log: getActionLog().entries, ctl };
}

const hasDevice = (names) => names.some((x) => x.startsWith('device_'));

test('access OFF (the default): no device tool is offered and a call is blocked', async () => {
  const r = await run([step(call('device_list', {})), step()]);
  assert.equal(hasDevice(r.offered[0]), false);
  assert.doesNotMatch(r.systems[0], /device_\*/);
  assert.equal(r.results[0].isError, true);
  assert.match(r.results[0].output, /Blocked: device access is off/);
  assert.equal(fake.calls.length, 0);
  assert.equal(r.log[0].status, 'blocked');
});

test('access ON: an interactive agent-mode chat gets all device tools and the prompt paragraph', async () => {
  await enable();
  const r = await run([step()]);
  for (const n of DEVICE_TOOL_NAMES) assert.ok(r.offered[0].includes(n), n);
  assert.ok(r.systems[0].includes(DEVICE_PROMPT));
});

test('a device call runs: approval names the device, the result carries refs, a screenshot comes as an image', async () => {
  await enable();
  const r = await run([
    step(call('device_open', { device: 'SIM-1' })),
    step(call('device_snapshot', { screenshot: true })),
    step(call('device_tap', { ref: '@e7' })),
    step(),
  ]);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].kind, 'device');
  assert.equal(r.approvals[0].device, 'iPhone 17 Pro (iOS 26.2)');
  const [open, snap, tap] = r.results;
  assert.match(open.output, /Using iPhone 17 Pro/);
  assert.match(snap.output, /@e7 \[cell\] "Основные"/);
  assert.equal(snap.image, 'iVBORw0KGgo=');
  assert.equal(snap.computer, false);
  assert.match(tap.output, /^Tapped\nNo visible change/);
  assert.deepEqual(fake.calls.find((c) => c.method === 'tap').args, ['SIM-1', { ref: 'e7' }]);
  assert.deepEqual(
    r.log.map((e) => [e.tool, e.summary, e.status]),
    [
      ['device_open', 'open SIM-1', 'success'],
      ['device_snapshot', 'snapshot + screenshot', 'success'],
      ['device_tap', 'tap @e7', 'success'],
    ],
  );
  assert.equal(r.log[0].approval, 'user');
});

test('the first-use question can be switched off in settings', async () => {
  await enable({ askFirst: false });
  const r = await run([step(call('device_open', { device: 'SIM-1' })), step()]);
  assert.equal(r.approvals.length, 0);
  assert.equal(r.results[0].isError, undefined);
});

test('declining the approval is a declined action and nothing reaches the device', async () => {
  await enable();
  const r = await run([step(call('device_open', { device: 'SIM-2' })), step()], { approve: () => false });
  assert.equal(r.results[0].isError, true);
  assert.match(r.results[0].output, /declined/i);
  assert.equal(r.log[0].status, 'declined');
  assert.equal(
    fake.calls.some((c) => c.method === 'boot'),
    false,
  );
});

test('invalid arguments and driver failures come back as tool errors, the run goes on', async () => {
  await enable({ askFirst: false });
  fake.state.failNext = 'simctl failed';
  const r = await run([
    step(call('device_tap', { ref: 'e1', x: 3, y: 4 })),
    step(call('device_press', { key: 'home' })),
    step(call('device_press', { key: 'back' })),
    step(),
  ]);
  assert.equal(r.results[0].isError, true);
  assert.match(r.results[0].output, /not both/);
  assert.equal(r.results[1].isError, true);
  assert.match(r.results[1].output, /simctl failed/);
  assert.equal(r.results[2].isError, undefined);
  assert.deepEqual(
    r.log.map((e) => e.status),
    ['error', 'error', 'success'],
  );
});

test('subagents, tool-restricted runs and scheduled runs are not offered the tools', async () => {
  await enable({ askFirst: false });
  for (const run_ of [
    { subagent: true },
    { toolNames: ['read_file', 'list_dir', 'search'] },
    { source: 'scheduled' },
  ]) {
    const r = await run([step(call('device_list', {})), step()], { run: run_ });
    assert.equal(hasDevice(r.offered[0]), false, JSON.stringify(run_));
    assert.equal(r.results[0].isError, true, JSON.stringify(run_));
    assert.match(r.results[0].output, /Blocked/);
  }
  assert.equal(fake.calls.length, 0);
});

test('a call site can opt a scheduled run in; Plan, Ask and read-only still never get the tools', async () => {
  await enable({ askFirst: false });
  const optIn = await run([step(call('device_list', {})), step()], { run: { source: 'scheduled', devices: true } });
  assert.equal(hasDevice(optIn.offered[0]), true);
  assert.match(optIn.results[0].output, /iPhone 17 Pro/);
  for (const o of [
    { run: { mode: 'plan' } },
    { run: { mode: 'ask' } },
    { access: 'readonly' },
    { access: 'readonly', run: { source: 'scheduled', devices: true } },
  ]) {
    const r = await run([step()], o);
    assert.equal(hasDevice(r.offered[0]), false, JSON.stringify(o));
  }
});

test('a model without tool support is offered none (CLI agents use the gustaf-device command instead)', async () => {
  await enable();
  const r = await run([step()], { run: { supportsTools: false } });
  assert.equal(r.offered[0].length, 0);
});

test('shutting a device down asks even when first use is not asked', async () => {
  await enable({ askFirst: false });
  const r = await run([step(call('device_close', { device: 'SIM-1', shutdown: true })), step()]);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].destructive, true);
  assert.equal(fake.devices[0].state, 'shutdown');
});

test('the agent-activity store shows the device during the run and is cleared after it', async () => {
  await enable({ askFirst: false });
  const during = [];
  const r = await run([
    step(call('device_open', { device: 'SIM-1' })),
    (/** second model turn: the first tool call already ran */) => {
      during.push(activity.getAgentActivity().map((a) => [a.chatId, a.deviceId, a.tool]));
      return step();
    },
  ]);
  assert.deepEqual(during, [[[5, 'SIM-1', 'device_open']]]);
  assert.deepEqual(activity.getAgentActivity(), []);
  assert.equal(r.results.length, 1);
});

test('Stop aborts an in-flight device call, ends the run and clears the activity', async () => {
  await enable({ askFirst: false });
  let hit;
  const started = new Promise((r) => (hit = r));
  const hung = new Promise(() => {});
  fake.driver.tap = () => {
    hit();
    return hung;
  };
  const r = await run([step(call('device_snapshot', {})), step(call('device_tap', { x: 3, y: 3 })), step()], {
    expectError: true,
    concurrent: async (ctl) => {
      await started;
      assert.equal(activity.getAgentActivity().length, 1);
      ctl.abort();
    },
  });
  assert.deepEqual(activity.getAgentActivity(), []);
  const tap = r.results.find((p) => p.name === 'device_tap');
  assert.equal(tap.isError, true);
  assert.equal(r.log.find((e) => e.tool === 'device_tap').status, 'cancelled');
});

test('Stop while the approval card is open denies it and ends the run', async () => {
  await enable();
  const r = await run([step(call('device_open', { device: 'SIM-1' })), step()], {
    expectError: true,
    approve: (_req, ctl) => new Promise((resolve) => setTimeout(() => (ctl.abort(), resolve(false)), 5)),
  });
  assert.equal(r.log[0].status, 'cancelled');
  assert.deepEqual(activity.getAgentActivity(), []);
});

// ---- CLI agents: the gustaf-device command ----

/** A scripted CLI-like adapter: runs its own tools (supportsTools false) and can use the device command. */
async function runCli(o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'device-cli-'));
  const seen = [];
  const started = [];
  const ended = [];
  const ctl = new AbortController();
  await runAgent({
    root,
    chatId: o.chatId ?? 9,
    supportsTools: false,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: {
      supportsComputer: false,
      supportsDeviceCommand: o.supportsDeviceCommand ?? true,
      supportsReasoning: () => false,
      listModels: async () => [],
      turn: async (input) => {
        seen.push({ system: input.system, device: input.device, tools: input.tools });
        return { parts: [{ type: 'text', text: 'done' }] };
      },
    },
    providerId: 'p',
    model: 'm',
    access: o.access ?? 'auto',
    computerUse: false,
    allowlist: [],
    signal: ctl.signal,
    onText: () => {},
    onMessage: async () => {},
    approve: async () => true,
    startDeviceCli:
      o.start ??
      (async (chatId, turn) => {
        started.push({ chatId, askFirst: turn.askFirst });
        return {
          env: { GUSTAF_DEVICE_URL: 'http://127.0.0.1:1/v1/device', GUSTAF_DEVICE_TOKEN: 'tok' },
          binDir: '/bin/dir',
          end: () => ended.push(chatId),
        };
      }),
    ...(o.run ?? {}),
  });
  return { seen, started, ended };
}

test('CLI agents get the environment, the PATH folder and the prompt paragraph only when access is on', async () => {
  const off = await runCli();
  assert.equal(off.seen[0].device, undefined);
  assert.doesNotMatch(off.seen[0].system, /gustaf-device/);
  assert.deepEqual(off.started, []);

  await enable();
  const on = await runCli();
  assert.deepEqual(on.seen[0].device, {
    env: { GUSTAF_DEVICE_URL: 'http://127.0.0.1:1/v1/device', GUSTAF_DEVICE_TOKEN: 'tok' },
    binDir: '/bin/dir',
  });
  assert.match(on.seen[0].system, /gustaf-device list/);
  assert.equal(hasDevice(on.seen[0].tools.map((t) => t.name)), false);
  assert.deepEqual(on.started, [{ chatId: 9, askFirst: true }]);
  assert.deepEqual(on.ended, [9], 'the bridge turn ends with the run');
});

test('CLI agents: no command for scheduled runs, subagents, read-only or Plan, or adapters without shell', async () => {
  await enable();
  for (const o of [
    { run: { source: 'scheduled' } },
    { run: { subagent: true } },
    { access: 'readonly' },
    { run: { mode: 'plan' } },
    { supportsDeviceCommand: false },
  ]) {
    const r = await runCli(o);
    assert.equal(r.seen[0].device, undefined, JSON.stringify(o));
    assert.deepEqual(r.started, [], JSON.stringify(o));
  }
});

test('CLI agents: an unavailable bridge (Windows) leaves the run without the command', async () => {
  await enable();
  const r = await runCli({ start: async () => null });
  assert.equal(r.seen[0].device, undefined);
  assert.doesNotMatch(r.seen[0].system, /gustaf-device/);
  const broken = await runCli({ start: async () => Promise.reject(new Error('boom')) });
  assert.equal(broken.seen[0].device, undefined);
});
