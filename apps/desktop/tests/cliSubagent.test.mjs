// CLI agents as subagents: routing by provider and role, the allow-list, isolated directories (worktree or shadow copy),
// access caps, stop, limits, quota failover and reports. Everything runs against fake CLI adapters and a fake worktree
// host: no CLI, git or process is started (the real adapters are providers/cli.ts, the worktree backend is Rust).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

register('./helpers/hooks.mjs', import.meta.url);
const { state, review } = await import('./helpers/apiStub.mjs');
const { createSubagentHost } = await import('../src/agent/subagents.ts');
const { Scheduler } = await import('../src/agent/scheduler.ts');
const { getRuns, resetAgentRuns, stopRun } = await import('../src/agent/agentRuns.ts');
const { normalizeRuns } = await import('../src/agent/agentRunsModel.ts');
const { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, selectProviderRoute, allowedProviderIds } = await import('../src/agent/agentSettings.ts');
const core = await import('../src/agent/subagentCore.ts');
const cli = await import('../src/agent/cliSubagentCore.ts');
const { parsePlanArgs } = await import('../src/agent/orchestrator.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES } = await import('../src/agent/rules.ts');

before(() => saveRulesConfig(DEFAULT_RULES));

const usage = { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 };
const act = (id, name, args, status = 'running', output) => ({ type: 'activity', id, name, args, status, ...(output ? { output } : {}) });

const settingsWith = (extra = {}) => normalizeAgentSettings({ ...extra });

/** A fake CLI: `script(input)` gets the turn input and returns the output (or throws). Records every turn. */
function fakeCli(name, script, calls) {
  return {
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      calls.push({ name, input });
      return script(input);
    },
  };
}
const finishWith = (text, extra = {}) => async (input) => {
  input.onActivity?.(act('t1', 'Read', { file_path: 'a.txt' }));
  input.onActivity?.(act('t1', 'Read', { file_path: 'a.txt' }, 'success', 'one'));
  input.onText(text);
  return { parts: [], usage, ...extra };
};
/** Resolves only when the signal aborts, like a CLI process that is killed. */
const hang = (seen) => (input) =>
  new Promise((_, reject) => {
    input.onActivity?.(act('h1', 'Bash', { command: 'sleep 100' }));
    input.signal.addEventListener('abort', () => {
      seen.killed = true;
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

function fakeWorktrees({ touched = false, files = [], none = false, inspectFails = false } = {}) {
  const log = { created: [], removed: [], inspected: [] };
  return {
    log,
    create: async (a) => {
      log.created.push(a);
      if (none) return null;
      const n = log.created.length;
      return { taskId: `w${n}`, branch: `gustaf/${a.title.toLowerCase().replace(/\W+/g, '-')}`, cwd: `/wt/w${n}`, path: `/wt/w${n}`, baseCommit: 'abc' };
    },
    inspect: async (root, taskId) => {
      log.inspected.push(taskId);
      if (inspectFails) throw new Error('boom');
      return { files, touched };
    },
    remove: async (root, taskId) => (log.removed.push(taskId), true),
  };
}

/** Provider directory over fake adapters. `defs`: id -> { name, kind: 'cli'|'api'|'bad', script, reason }. */
function directory(defs, calls) {
  return {
    list: () => Object.entries(defs).map(([id, d]) => ({ id, name: d.name, ...(d.kind !== 'api' ? { cli: true } : {}) })),
    resolve: async (id, model) => {
      const d = defs[id];
      if (d.kind === 'bad') return { ok: false, reason: d.reason };
      const adapter = fakeCli(id, d.script, calls);
      return d.kind === 'cli' ? { ok: true, kind: 'cli', adapter, cli: 'codex', model: model ?? 'default', name: d.name } : { ok: true, kind: 'api', adapter, supportsTools: true, model: model ?? 'm1', name: d.name };
    },
  };
}

function setup({ defs = {}, settings = {}, wt = fakeWorktrees(), hostCfg = {}, parentAccess = 'auto' } = {}) {
  state.reset();
  resetAgentRuns();
  const calls = [];
  const prepared = [];
  const failures = [];
  const root = mkdtempSync(join(tmpdir(), 'cli-sub-'));
  const ctl = new AbortController();
  const host = createSubagentHost({
    projectRoot: root,
    recordTokens: () => {},
    settings: settingsWith({ allowedProviders: Object.keys(defs), ...settings }),
    providers: directory(defs, calls),
    worktrees: wt,
    scheduler: new Scheduler(3),
    retryBackoffMs: () => 0,
    onCliFailure: (f) => void failures.push(f),
    checkBudget: async () => null,
    prepare: async (r) => {
      prepared.push(r);
      return { review: { id: `r${prepared.length}`, root: r, workspace: '/shadow', linked: [] }, setup: null };
    },
    ...hostCfg,
  });
  review.list = async () => [];
  review.finish = async () => {};
  const parent = { root, providerId: 'p', model: 'm', access: parentAccess, allowlist: [], signal: ctl.signal, approve: async () => true, adapter: null, chatId: 7, supportsTools: true };
  return { host, parent, calls, prepared, failures, wt, root, ctl };
}

const cliDefs = (script, extra = {}) => ({ codex1: { name: 'Codex', kind: 'cli', script }, ...extra });

// ---- pure parts ----

test('providers that cannot run non-interactively are refused with a reason', () => {
  assert.deepEqual(cli.cliSubagentSupport({ kind: 'cli', cli: 'codex', name: 'Codex' }), { ok: true, cli: 'codex' });
  assert.deepEqual(cli.cliSubagentSupport({ kind: 'cli', cli: 'cursor-agent' }), { ok: true, cli: 'cursor-agent' });
  assert.equal(cli.cliSubagentSupport({ kind: 'cli', cli: 'weird', name: 'Weird' }).ok, false);
  const sdk = cli.cliSubagentSupport({ kind: 'cursor', name: 'Cursor' });
  assert.equal(sdk.ok, false);
  assert.match(sdk.reason, /non-interactively/);
  assert.equal(cli.cliSubagentSupport({ kind: 'openai' }), null, 'API providers run the normal subagent loop');
});

test('a CLI subagent never gets more than "auto" access, and read-only types stay read-only', () => {
  assert.equal(cli.cliAccess('explore', 'full'), 'readonly');
  assert.equal(cli.cliAccess('review', 'auto'), 'readonly');
  assert.equal(cli.cliAccess('general', 'full'), 'auto');
  assert.equal(cli.cliAccess('general', 'auto'), 'auto');
  assert.equal(cli.cliAccess('general', 'readonly'), 'readonly');
});

test('CLI failures are classified: quota, rate limit, sign-in, other', () => {
  const now = Date.parse('2026-10-04T00:00:00Z');
  const q = cli.classifyCliFailure("You've hit your usage limit. Upgrade to Pro. Try again in 2 hours.", now);
  assert.equal(q.kind, 'quota');
  assert.equal(q.quota.resetAt, now + 2 * 3_600_000);
  assert.equal(cli.classifyCliFailure('HTTP 401 Unauthorized\n\nCodex: codex login', now).kind, 'auth');
  assert.equal(cli.classifyCliFailure('Too many requests, slow down', now).kind, 'rate_limit');
  assert.equal(cli.classifyCliFailure('segfault in tool', now).kind, 'other');
  assert.equal(cli.movesToFallback('other'), false);
  assert.equal(cli.movesToFallback('quota'), true);
  // The provider of an attempt moves along the chain after provider-specific failures and stays on the last entry.
  assert.equal(cli.chainIndex([], 3), 0);
  assert.equal(cli.chainIndex(['quota'], 3), 1);
  assert.equal(cli.chainIndex(['other'], 3), 0);
  assert.equal(cli.chainIndex(['quota', 'auth', 'quota'], 3), 2);
  assert.equal(cli.chainIndex(['quota'], 1), 0, 'no fallback: the same provider');
});

test('the collector counts a call once and reports the final message', () => {
  const c = cli.createCliCollector();
  c.text('Looking around. ');
  assert.equal(c.activity(act('a', 'Read', {})), true);
  assert.equal(c.activity(act('a', 'Read', {}, 'success')), false);
  assert.deepEqual(c.flush(), ['Looking around.']);
  c.text('Found it.');
  assert.equal(c.activity(act('b', 'Bash', {})), true);
  assert.equal(c.toolCalls(), 2);
  assert.equal(c.final(), 'Found it.', 'ends on a call: the last text counts');
  c.text('All done.');
  assert.equal(c.final(), 'All done.');
  assert.deepEqual(c.flush(true), ['Found it.', 'All done.']);
});

test('activities become transcript steps', () => {
  const s = cli.activityStep(act('a', 'Bash', { command: 'ls  -la\nfoo' }, 'error', 'denied'), 5);
  assert.deepEqual(s, { at: 5, kind: 'tool', tool: 'Bash', text: 'ls -la foo', result: 'denied', error: true });
  assert.equal(cli.activityLabel(act('a', 'Read', { file_path: 'x.ts' })), 'Read x.ts');
});

test('provider and role arguments are validated before anything runs', () => {
  const ok = core.parseSpawnArgs({ title: 't', prompt: 'p', type: 'general', provider: ' codex1 ', fallbackProviders: ['a', 'a', 'b'] });
  assert.equal(ok.value.provider, 'codex1');
  assert.deepEqual(ok.value.fallbackProviders, ['a', 'b']);
  assert.match(core.parseSpawnArgs({ title: 't', prompt: 'p', type: 'general', role: 'boss' }).error, /planner, implementer, reviewer, tester/);
  assert.match(core.parseSpawnArgs({ title: 't', prompt: 'p', type: 'general', role: 'tester', model: 'x' }).error, /either `role` or/);
  assert.match(core.parseSpawnArgs({ title: 't', prompt: 'p', type: 'general', fallbackProviders: 'a' }).error, /list of provider ids/);
  const plan = parsePlanArgs({ tasks: [{ id: 'a', title: 'A', prompt: 'p', type: 'plan', role: 'wizard' }] }, { cancelDependents: true });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /Task "a": `role` must be one of/);
  assert.equal(core.parseSpawnArgs({ title: 't', prompt: 'p', type: 'plan' }).value.provider, undefined, 'default behaviour: nothing set');
});

test('settings: roles, allowed providers and cleanup are normalized; roles need an allowed provider', () => {
  const s = normalizeAgentSettings({ roles: { planner: { providerId: 'a', model: 'm' }, boss: { providerId: 'x', model: 'y' }, tester: { providerId: '' } }, allowedProviders: ['a', 'a', '', 5, 'b'], cleanupUntouchedWorktrees: 1 });
  assert.deepEqual(s.roles, { planner: { providerId: 'a', model: 'm' } });
  assert.deepEqual(s.allowedProviders, ['a', 'b']);
  assert.equal(s.cleanupUntouchedWorktrees, false, 'only a real true switches it on');
  assert.deepEqual(normalizeAgentSettings(undefined), DEFAULT_AGENT_SETTINGS);
  const known = [{ id: 'a', name: 'Alpha', cli: true }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];
  assert.equal(selectProviderRoute({}, s, 'p', known), null);
  assert.equal(selectProviderRoute({ role: 'planner' }, s, 'p', known).ok, true);
  assert.match(selectProviderRoute({ role: 'tester' }, s, 'p', known).error, /no provider configured/);
  assert.match(selectProviderRoute({ provider: 'c' }, s, 'p', known).error, /not allowed/);
  assert.equal(selectProviderRoute({ provider: 'gamma' }, { ...s, allowedProviders: ['c'] }, 'p', known).route.providerId, 'c', 'a unique name matches');
  const notAllowedRole = { ...s, allowedProviders: [] };
  assert.match(selectProviderRoute({ role: 'planner' }, notAllowedRole, 'p', known).error, /Provider of role "planner" "a" is not allowed/);
  assert.deepEqual(allowedProviderIds({ ...s, models: { explore: { providerId: 'q', model: 'm' } } }, 'p'), ['p', 'q', 'a', 'b']);
});

// ---- runtime ----

test('provider validation and allow-list: nothing starts for a provider that is not allowed', async () => {
  const { host, parent, calls } = setup({ defs: cliDefs(finishWith('x'), { other: { name: 'Other', kind: 'cli', script: finishWith('y') } }), settings: { allowedProviders: ['codex1'] } });
  await assert.rejects(host.spawn({ title: 'T', prompt: 'p', type: 'explore', provider: 'other' }, parent), /not allowed for subagents/);
  await assert.rejects(host.spawn({ title: 'T', prompt: 'p', type: 'explore', provider: 'nope' }, parent), /not a known, enabled provider/);
  await assert.rejects(host.delegate({ tasks: [{ id: 'a', title: 'A', prompt: 'p', type: 'explore' }, { id: 'b', title: 'B', prompt: 'p', type: 'explore', provider: 'other' }] }, parent), /Task "b": .*not allowed/);
  assert.equal(calls.length, 0);
  assert.equal(getRuns().length, 0, 'the whole plan is refused: task a did not start either');
  const out = await host.spawn({ title: 'T', prompt: 'p', type: 'explore', provider: 'Codex' }, parent);
  assert.match(out, /Subagent "T" \(explore, via Codex\) finished\./);
  assert.equal(calls.length, 1);
});

test('without a provider directory a provider or role is refused; no argument keeps today\'s behaviour', async () => {
  const { host, parent } = setup({ hostCfg: { providers: undefined } });
  await assert.rejects(host.spawn({ title: 'T', prompt: 'p', type: 'explore', provider: 'x' }, parent), /not available here/);
  await assert.rejects(host.delegate({ tasks: [{ id: 'a', title: 'T', prompt: 'p', type: 'explore', fallbackProviders: ['x'] }] }, parent), /needs a `provider` or a `role`/);
});

test('tools name the allowed providers and the usable roles', async () => {
  const { host } = setup({ defs: cliDefs(finishWith('x')), settings: { roles: { implementer: { providerId: 'codex1', model: 'gpt' }, tester: { providerId: 'ghost', model: 'm' } } } });
  const [spawn, delegate] = await host.tools({ providerId: 'p', model: 'm' });
  assert.match(spawn.description, /Providers you may pass in `provider`: codex1 \(Codex, CLI agent\)/);
  assert.match(spawn.description, /Roles you may pass in `role`: implementer\./);
  assert.ok(!/tester/.test(spawn.description.split('Roles you may')[1]));
  assert.match(delegate.description, /codex1/);
  assert.ok('provider' in core.SPAWN_TOOL.parameters.properties && 'role' in core.SPAWN_TOOL.parameters.properties);
});

test('roles resolve to their provider and model; an unconfigured role is refused before anything starts', async () => {
  const { host, parent, calls } = setup({ defs: cliDefs(finishWith('done')), settings: { roles: { implementer: { providerId: 'codex1', model: 'gpt-5' } } } });
  await assert.rejects(host.delegate({ tasks: [{ id: 'a', title: 'A', prompt: 'p', type: 'explore', role: 'implementer' }, { id: 'b', title: 'B', prompt: 'p', type: 'explore', role: 'reviewer' }] }, parent), /Role "reviewer" has no provider configured/);
  assert.equal(calls.length, 0);
  assert.equal(getRuns().length, 0);
  await host.spawn({ title: 'Impl', prompt: 'p', type: 'explore', role: 'implementer' }, parent);
  assert.equal(calls[0].input.model, 'gpt-5');
  const run = getRuns()[0];
  assert.equal(run.providerId, 'codex1');
  assert.equal(run.model, 'gpt-5');
});

test('a role whose provider is not allowed is refused (the allow-list applies to roles)', async () => {
  const { host, parent } = setup({ defs: cliDefs(finishWith('x')), settings: { allowedProviders: [], roles: { planner: { providerId: 'codex1', model: 'm' } } } });
  await assert.rejects(host.spawn({ title: 'T', prompt: 'p', type: 'plan', role: 'planner' }, parent), /Provider of role "planner" "codex1" is not allowed/);
});

test('an unusable provider is refused with its reason', async () => {
  const { host, parent } = setup({ defs: { sdk: { name: 'Cursor', kind: 'bad', reason: 'the Cursor SDK cannot run non-interactively.' } } });
  await assert.rejects(host.spawn({ title: 'T', prompt: 'p', type: 'general', provider: 'sdk' }, parent), /Provider "sdk" cannot run this subagent: the Cursor SDK cannot run non-interactively/);
});

test('a read-only CLI subagent runs read-only in the parent folder, without tools, computer use or a worktree', async () => {
  const { host, parent, calls, wt } = setup({ defs: cliDefs(finishWith('Found: a.txt line 1.')), parentAccess: 'full' });
  const out = await host.spawn({ title: 'Look', prompt: 'find it', type: 'review', provider: 'codex1', files: ['a.txt'] }, parent);
  const { input } = calls[0];
  assert.equal(input.access, 'readonly');
  assert.equal(input.cwd, parent.root);
  assert.deepEqual(input.tools, []);
  assert.equal(input.computer, undefined);
  assert.equal(input.killTree, true);
  assert.equal(input.messages[0].parts[0].text, 'find it');
  assert.match(input.system, /You are a subagent/);
  assert.match(input.system, /read-only/);
  assert.match(input.system, /Focus on: a.txt/);
  assert.equal(wt.log.created.length, 0);
  assert.match(out, /Found: a.txt line 1\./);
  const run = getRuns()[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.toolUses, 1);
  assert.equal(run.tokens, 15, 'tokens reported by the CLI are counted');
  assert.ok(run.transcript.some((s) => s.kind === 'tool' && s.tool === 'Read' && s.result === 'one'));
});

test('a general CLI subagent works in its own worktree, capped at "auto", and the branch is left in place and named in the report', async () => {
  const wt = fakeWorktrees({ touched: true, files: ['src/a.ts', 'src/b.ts'] });
  const { host, parent, calls, prepared } = setup({ defs: cliDefs(finishWith('Edited two files.')), wt, parentAccess: 'full' });
  const out = await host.spawn({ title: 'Fix the bug', prompt: 'do it', type: 'general', provider: 'codex1' }, parent);
  assert.equal(wt.log.created.length, 1);
  assert.equal(wt.log.created[0].providerId, 'codex1');
  assert.equal(calls[0].input.cwd, '/wt/w1');
  assert.equal(calls[0].input.access, 'auto', 'never "full": no sandbox bypass');
  assert.equal(prepared.length, 0, 'a git project gets a worktree, not a shadow copy');
  assert.match(out, /on branch gustaf\/fix-the-bug \(worktree \/wt\/w1\), left in place; nothing was committed, merged or pushed/);
  assert.match(out, /src\/a.ts, src\/b.ts/);
  assert.deepEqual(wt.log.removed, []);
  const run = getRuns()[0];
  assert.deepEqual(run.changed, ['src/a.ts', 'src/b.ts']);
  assert.ok(run.warnings.some((w) => /gustaf\/fix-the-bug/.test(w)));
});

test('the worktree of an untouched run stays by default and goes only when the setting is on; a touched one always stays', async () => {
  const keep = fakeWorktrees({ touched: false });
  const a = setup({ defs: cliDefs(finishWith('Nothing to do.')), wt: keep });
  const outA = await a.host.spawn({ title: 'Idle', prompt: 'p', type: 'general', provider: 'codex1' }, a.parent);
  assert.deepEqual(keep.log.removed, []);
  assert.match(outA, /No files were changed\. Branch gustaf\/idle was left in place/);

  const clean = fakeWorktrees({ touched: false });
  const b = setup({ defs: cliDefs(finishWith('Nothing to do.')), wt: clean, settings: { cleanupUntouchedWorktrees: true } });
  const outB = await b.host.spawn({ title: 'Idle', prompt: 'p', type: 'general', provider: 'codex1' }, b.parent);
  assert.deepEqual(clean.log.removed, ['w1']);
  assert.match(outB, /were removed/);

  const touched = fakeWorktrees({ touched: true, files: ['x'] });
  const c = setup({ defs: cliDefs(finishWith('Changed.')), wt: touched, settings: { cleanupUntouchedWorktrees: true } });
  await c.host.spawn({ title: 'Work', prompt: 'p', type: 'general', provider: 'codex1' }, c.parent);
  assert.deepEqual(touched.log.removed, []);

  const unreadable = fakeWorktrees({ inspectFails: true });
  const d = setup({ defs: cliDefs(finishWith('?')), wt: unreadable, settings: { cleanupUntouchedWorktrees: true } });
  await d.host.spawn({ title: 'Unknown', prompt: 'p', type: 'general', provider: 'codex1' }, d.parent);
  assert.deepEqual(unreadable.log.removed, [], 'never removed when its state is unknown');
});

test('a project without git gets a private shadow copy instead of a worktree', async () => {
  const { host, parent, calls, prepared, wt } = setup({ defs: cliDefs(finishWith('ok')), wt: fakeWorktrees({ none: true }) });
  review.list = async () => [[{ id: 'r1' }, [{ path: 'new.txt', binary: false }]]];
  const out = await host.spawn({ title: 'Copy', prompt: 'p', type: 'general', provider: 'codex1' }, parent);
  assert.equal(prepared.length, 1);
  assert.equal(calls[0].input.cwd, '/shadow');
  assert.equal(wt.log.inspected.length, 0);
  assert.match(out, /Changed files \(1, pending in a separate review/);
});

test('stop kills the CLI process: the adapter sees the abort and the run is cancelled', async () => {
  const seen = {};
  const { host, parent } = setup({ defs: cliDefs(hang(seen)) });
  const pending = host.spawn({ title: 'Hang', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  await sleep(30);
  const run = getRuns()[0];
  assert.equal(run.status, 'running');
  assert.equal(run.toolUses, 1);
  // A restart at this moment would mark it interrupted.
  assert.equal(normalizeRuns(JSON.parse(JSON.stringify(getRuns())))[0].status, 'interrupted');
  stopRun(run.id);
  const out = await pending;
  assert.equal(seen.killed, true);
  assert.match(out, /was cancelled/);
  assert.equal(getRuns()[0].status, 'cancelled');
});

test('stopping the parent kills a running CLI subagent too', async () => {
  const seen = {};
  const { host, parent, ctl } = setup({ defs: cliDefs(hang(seen)) });
  const pending = host.spawn({ title: 'Hang', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  await sleep(30);
  ctl.abort();
  await pending;
  assert.equal(seen.killed, true);
});

test('a tool-call limit breach kills the CLI and reports the limit', async () => {
  const seen = {};
  const script = (input) =>
    new Promise((_, reject) => {
      input.signal.addEventListener('abort', () => ((seen.killed = true), reject(new DOMException('Aborted', 'AbortError'))));
      for (let i = 0; i < 5; i++) input.onActivity(act(`c${i}`, 'Bash', { command: `cmd ${i}` }));
    });
  const { host, parent } = setup({ defs: cliDefs(script), hostCfg: { budgets: { explore: { maxToolCalls: 2 } } } });
  const out = await host.spawn({ title: 'Busy', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  assert.equal(seen.killed, true);
  assert.match(out, /stopped at its tool call limit \(2\)/);
  assert.equal(getRuns()[0].status, 'limit');
});

test('a time limit breach kills the CLI', async () => {
  const seen = {};
  const { host, parent } = setup({ defs: cliDefs(hang(seen)), hostCfg: { budgets: { explore: { maxMs: 40 } } } });
  const out = await host.spawn({ title: 'Slow', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  assert.equal(seen.killed, true);
  assert.match(out, /time limit/);
  assert.equal(getRuns()[0].status, 'limit');
});

test('the user token budget stops a CLI subagent that is running', async () => {
  const seen = {};
  const script = (input) =>
    new Promise((_, reject) => {
      input.signal.addEventListener('abort', () => ((seen.killed = true), reject(new DOMException('Aborted', 'AbortError'))));
      input.onActivity(act('c1', 'Bash', { command: 'x' }));
    });
  let n = 0;
  const { host, parent } = setup({ defs: cliDefs(script), hostCfg: { checkBudget: async () => (++n > 2 ? 'day' : null) } });
  const out = await host.spawn({ title: 'Costly', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  assert.equal(seen.killed, true);
  assert.match(out, /was stopped: the daily token budget is exceeded/);
  assert.equal(getRuns()[0].status, 'budget');
});

test('tokens over the limit mark the run limit-stopped after it ended', async () => {
  const big = { input: 400_000, output: 300_000, cached: 0, cacheWrite: 0, reasoning: 0 };
  const { host, parent } = setup({ defs: cliDefs(finishWith('done', { usage: big })) });
  const out = await host.spawn({ title: 'Big', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  assert.match(out, /stopped at its token limit/);
});

test('a quota failure fails the task with a clear reason and is reported to the app', async () => {
  const quota = () => {
    throw new Error("You've hit your usage limit. Try again in 3 hours.");
  };
  const { host, parent, failures } = setup({ defs: cliDefs(quota) });
  const out = await host.spawn({ title: 'Q', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  assert.match(out, /failed: quota or usage limit reached/);
  assert.equal(getRuns()[0].status, 'failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].providerId, 'codex1');
  assert.equal(failures[0].failure.kind, 'quota');
  assert.ok(failures[0].failure.quota.resetAt > Date.now());
});

test('quota failure with retries moves to the next fallback provider, else retries the same one', async () => {
  const order = [];
  const quota = () => (order.push('A'), Promise.reject(new Error('usage limit reached')));
  const ok = (input) => (order.push('B'), finishWith('B did it')(input));
  const defs = { A: { name: 'Alpha', kind: 'cli', script: quota }, B: { name: 'Beta', kind: 'cli', script: ok } };
  const s = setup({ defs });
  const out = await s.host.delegate({ retries: 1, tasks: [{ id: 't', title: 'Task', prompt: 'p', type: 'explore', provider: 'A', fallbackProviders: ['B'] }] }, s.parent);
  assert.deepEqual(order, ['A', 'B']);
  assert.match(out, /t "Task".*: completed, 2 attempts/);
  assert.match(out, /via Beta/);

  const order2 = [];
  const flaky = () => (order2.push('A'), order2.length === 1 ? Promise.reject(new Error('usage limit reached')) : finishWith('second time')({ onActivity() {}, onText() {} }));
  const s2 = setup({ defs: { A: { name: 'Alpha', kind: 'cli', script: flaky } } });
  const out2 = await s2.host.delegate({ retries: 1, tasks: [{ id: 't', title: 'Task', prompt: 'p', type: 'explore', provider: 'A' }] }, s2.parent);
  assert.deepEqual(order2, ['A', 'A']);
  assert.match(out2, /completed, 2 attempts/);

  const s3 = setup({ defs });
  await assert.rejects(s3.host.delegate({ retries: 1, tasks: [{ id: 't', title: 'Task', prompt: 'p', type: 'explore', provider: 'A', fallbackProviders: ['zzz'] }] }, s3.parent), /Task "t": Fallback provider "zzz"/);
});

test('a failed worktree attempt that will be retried is cleaned up when untouched, kept when it holds work', async () => {
  const fail = () => Promise.reject(new Error('Not logged in: codex login'));
  const wt = fakeWorktrees({ touched: false });
  const s = setup({ defs: { A: { name: 'Alpha', kind: 'cli', script: fail } }, wt });
  await s.host.delegate({ retries: 1, tasks: [{ id: 't', title: 'Edit', prompt: 'p', type: 'general', files: ['a'], provider: 'A' }] }, s.parent);
  assert.equal(wt.log.created.length, 2);
  assert.deepEqual(wt.log.removed, ['w1'], 'only the replaced attempt; the last one is kept');
  const wt2 = fakeWorktrees({ touched: true, files: ['a'] });
  const s2 = setup({ defs: { A: { name: 'Alpha', kind: 'cli', script: fail } }, wt: wt2 });
  await s2.host.delegate({ retries: 1, tasks: [{ id: 't', title: 'Edit', prompt: 'p', type: 'general', files: ['a'], provider: 'A' }] }, s2.parent);
  assert.deepEqual(wt2.log.removed, []);
});

test('mixed providers: a CLI task after an API task gets its report, in dependency order', async () => {
  const events = [];
  const apiTurn = async (input) => {
    events.push('api:start');
    await sleep(15);
    events.push('api:end');
    return { parts: [{ type: 'text', text: 'API report: plan is X' }], usage };
  };
  const cliTurn = (input) => {
    events.push('cli:start');
    return finishWith('CLI implemented X')(input);
  };
  const defs = { api1: { name: 'Anthropic', kind: 'api', script: apiTurn }, codex1: { name: 'Codex', kind: 'cli', script: cliTurn } };
  const wt = fakeWorktrees({ touched: true, files: ['x.ts'] });
  const s = setup({ defs, wt });
  const out = await s.host.delegate({
    tasks: [
      { id: 'impl', title: 'Implement', prompt: 'implement the plan', type: 'general', files: ['x.ts'], provider: 'codex1', dependsOn: ['plan'] },
      { id: 'plan', title: 'Plan', prompt: 'make a plan', type: 'plan', provider: 'api1' },
    ],
  }, s.parent);
  assert.deepEqual(events, ['api:start', 'api:end', 'cli:start']);
  const cliCall = s.calls.find((c) => c.name === 'codex1');
  assert.match(cliCall.input.messages[0].parts[0].text, /API report: plan is X/);
  assert.match(out, /impl "Implement" \(general, codex1, after plan\): completed/);
  assert.match(out, /plan "Plan" \(plan, api1\): completed/);
  assert.deepEqual(getRuns().map((r) => r.providerId).sort(), ['api1', 'codex1']);
});

test('a CLI task that fails to prepare its directory fails cleanly', async () => {
  const wt = { ...fakeWorktrees(), create: async () => { throw new Error('git_error: no space left'); } };
  const { host, parent, calls } = setup({ defs: cliDefs(finishWith('x')), wt });
  const out = await host.spawn({ title: 'W', prompt: 'p', type: 'general', provider: 'codex1' }, parent);
  assert.match(out, /could not prepare an isolated directory: git_error: no space left/);
  assert.equal(calls.length, 0);
  assert.equal(getRuns()[0].status, 'failed');
});

test('the report of a CLI subagent is capped like any other', async () => {
  const { host, parent } = setup({ defs: cliDefs(finishWith('x'.repeat(20_000))) });
  const out = await host.spawn({ title: 'Long', prompt: 'p', type: 'explore', provider: 'codex1' }, parent);
  assert.ok(out.length < 8_300);
  assert.match(out, /report truncated/);
});

test('without provider or role nothing changes: the API subagent loop runs as before', async () => {
  const seen = [];
  const adapter = { supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: async (i) => (seen.push(i), { parts: [{ type: 'text', text: 'API says hi' }], usage }) };
  const s = setup({ defs: cliDefs(finishWith('x')) });
  const out = await s.host.spawn({ title: 'Plain', prompt: 'p', type: 'explore' }, { ...s.parent, adapter, root: s.root });
  assert.match(out, /Subagent "Plain" \(explore\) finished\./);
  assert.equal(seen.length, 1);
  assert.equal(s.calls.length, 0);
  assert.ok(seen[0].tools.length > 0, 'the loop offers its own tools');
});
