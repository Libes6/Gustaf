// Who gets the `gustaf-agent` command inside the real agent loop (src/agent/agent.ts): CLI main agents get the environment,
// the PATH folder and the prompt paragraph only when the setting is on and the run may spawn subagents; API main agents keep
// the spawn_agent tool and can name CLI providers in it. The bridge itself is faked here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { runAgent } = await import('../src/agent/agent.ts');
const { createSubagentHost } = await import('../src/agent/subagents.ts');
const { normalizeAgentSettings } = await import('../src/agent/agentSettings.ts');
const { saveDeviceSettings, resetDeviceSettings } = await import('../src/agent/deviceSettingsStore.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');
const { AGENT_CLI_PROMPT } = await import('../src/agent/agentCli.ts');

beforeEach(async () => {
  state.reset();
  resetDeviceSettings();
  await saveRulesConfig(DEFAULT_RULES);
});

const known = [
  { id: 'opus', name: 'Claude Code', cli: true, models: [{ id: 'haiku', name: 'Haiku' }] },
  { id: 'cursor1', name: 'Cursor', cli: true, models: [{ id: 'composer-2', name: 'Composer 2' }] },
];
const hostFor = (extra = {}) =>
  createSubagentHost({
    projectRoot: '/p',
    recordTokens: () => {},
    settings: normalizeAgentSettings({ allowedProviders: ['cursor1'], ...extra }),
    providers: { list: () => known, resolve: async () => ({ ok: false, reason: 'unused' }) },
  });

/** One scripted turn of a CLI-like or API adapter; `o` overrides the run options. */
async function run(o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-wiring-'));
  const seen = [];
  const started = [];
  const ended = [];
  const ctl = new AbortController();
  await runAgent({
    root,
    chatId: o.chatId ?? 5,
    // CLI models are listed with tool support: the loop must not rely on `supportsTools === false` to spot a CLI agent.
    supportsTools: true,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: {
      supportsComputer: false,
      supportsDeviceCommand: o.cli ?? true,
      supportsReasoning: () => false,
      listModels: async () => [],
      turn: async (input) => {
        seen.push(input);
        return { parts: [{ type: 'text', text: 'done' }] };
      },
    },
    providerId: 'opus',
    model: 'haiku',
    access: o.access ?? 'auto',
    computerUse: false,
    allowlist: [],
    signal: ctl.signal,
    onText: () => {},
    onMessage: async () => {},
    approve: async () => true,
    subagents: 'subagents' in o ? o.subagents : hostFor(o.settings),
    startAgentCli:
      o.start ??
      (async (chatId, turn) => {
        started.push({ chatId, host: turn.host, parent: turn.parent });
        return {
          env: { GUSTAF_BRIDGE_URL: 'http://127.0.0.1:1/v1', GUSTAF_BRIDGE_TOKEN: 'tok' },
          binDir: '/bin/dir',
          end: () => ended.push(chatId),
        };
      }),
    startDeviceCli: async (chatId) => ({
      env: { GUSTAF_BRIDGE_URL: 'http://127.0.0.1:1/v1', GUSTAF_BRIDGE_TOKEN: 'tok' },
      binDir: '/bin/dir',
      end: () => ended.push(`device${chatId}`),
    }),
    ...(o.run ?? {}),
  });
  return { seen, started, ended };
}

test('a CLI main agent gets the command, the environment, the allowed-tools flag input and the prompt paragraph', async () => {
  const r = await run();
  assert.equal(r.started.length, 1);
  assert.equal(r.started[0].chatId, 5);
  assert.equal(
    r.started[0].parent.providerId,
    'opus',
    'the parent options (access, approvals, provider) travel with the turn',
  );
  assert.deepEqual(r.seen[0].device, {
    env: { GUSTAF_BRIDGE_URL: 'http://127.0.0.1:1/v1', GUSTAF_BRIDGE_TOKEN: 'tok' },
    binDir: '/bin/dir',
    commands: ['agent'],
  });
  assert.ok(r.seen[0].system.includes(AGENT_CLI_PROMPT));
  assert.deepEqual(r.ended, [5], 'the bridge turn ends with the run (its tasks stop)');
  assert.equal(
    r.seen[0].tools.some((t) => t.name === 'spawn_agent'),
    false,
    'a CLI agent ignores tool definitions: it is not offered spawn_agent',
  );
});

test('both commands share one environment when device access is on too', async () => {
  await saveDeviceSettings({ access: true, askFirst: true });
  const r = await run();
  assert.deepEqual(r.seen[0].device.commands, ['device', 'agent']);
  assert.match(r.seen[0].system, /gustaf-device list/);
  assert.ok(r.seen[0].system.includes(AGENT_CLI_PROMPT));
  assert.equal(r.seen[0].device.binDir, '/bin/dir');
});

test('setting off: no command, no environment, no prompt paragraph', async () => {
  const r = await run({ settings: { cliSubagents: false } });
  assert.deepEqual(r.started, []);
  assert.equal(r.seen[0].device, undefined);
  assert.doesNotMatch(r.seen[0].system, /gustaf-agent/);
});

test('no command for read-only access, Plan or Ask mode, runs without subagents, adapters without a shell, or no chat', async () => {
  for (const o of [
    { access: 'readonly' },
    { run: { mode: 'plan' } },
    { run: { mode: 'ask' } },
    { subagents: undefined },
    { cli: false },
    { chatId: null, run: { chatId: undefined } },
    { run: { subagent: true } },
  ]) {
    const r = await run(o);
    assert.deepEqual(r.started, [], JSON.stringify(o));
    assert.equal(r.seen[0].device, undefined, JSON.stringify(o));
    assert.doesNotMatch(r.seen[0].system, /gustaf-agent/, JSON.stringify(o));
  }
});

test('an unavailable bridge (Windows) leaves the run without the command', async () => {
  const none = await run({ start: async () => null });
  assert.equal(none.seen[0].device, undefined);
  assert.doesNotMatch(none.seen[0].system, /gustaf-agent/);
  const broken = await run({ start: async () => Promise.reject(new Error('boom')) });
  assert.equal(broken.seen[0].device, undefined);
});

test('an API main agent keeps spawn_agent and may name CLI providers the settings allow', async () => {
  const r = await run({ cli: false });
  assert.deepEqual(r.started, [], 'an API model gets the tool, not the command');
  const spawn = r.seen[0].tools.find((t) => t.name === 'spawn_agent');
  assert.ok(spawn, 'spawn_agent is offered');
  assert.match(spawn.description, /Providers you may pass in `provider`: cursor1 \(Cursor, CLI agent\)/);
  assert.ok(r.seen[0].tools.some((t) => t.name === 'delegate_tasks'));
  // A provider the setting does not allow is not named.
  const none = await run({ cli: false, settings: { allowedProviders: [] } });
  assert.doesNotMatch(none.seen[0].tools.find((t) => t.name === 'spawn_agent').description, /cursor1/);
});
