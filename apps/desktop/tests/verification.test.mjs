// Verification gates (docs/features/verification-gates.md): the pure schema / signature / text logic, and the agent loop
// running the gate against a scripted model and a fake command runner (tests/helpers/apiStub.mjs records every command,
// nothing is executed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const core = await import('../src/agent/verificationCore.ts');
const { loadVerificationView, saveVerificationSettings, suggestChecks, loadVerificationConfig } = await import('../src/agent/verificationStore.ts');
const { runAgent } = await import('../src/agent/agent.ts');
const { saveRulesConfig } = await import('../src/agent/rulesStore.ts');
const { DEFAULT_RULES, normalizeRulesConfig } = await import('../src/agent/rules.ts');
const { clearActionLog, getActionLog } = await import('../src/agent/actionLogStore.ts');
const { normalizeActionLog, actionKind } = await import('../src/agent/actionLog.ts');

const chk = (command, extra = {}) => ({ name: command, command, ...extra });

// ---------- schema ----------

test('a valid check gets defaults: name from the command, 120 s timeout', () => {
  const r = core.validateChecks([{ command: ' npm test ' }, { name: 'types', command: 'tsc --noEmit', timeoutMs: 5000 }], 'settings');
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.checks[0], { name: 'npm test', command: 'npm test', timeoutMs: 120000, source: 'settings' });
  assert.deepEqual(r.checks[1], { name: 'types', command: 'tsc --noEmit', timeoutMs: 5000, source: 'settings' });
});

test('invalid entries are skipped and reported, valid ones kept', () => {
  const r = core.validateChecks(
    [{ command: '' }, 5, { command: 'ok' }, { command: 'x', timeoutMs: 999 }, { command: 'x', timeoutMs: 600001 }, { command: 'x', timeoutMs: 1.5 }, { command: 'x', name: 3 }, { command: 'x', name: 'n'.repeat(61) }, { command: 'y'.repeat(2001) }, { command: 'fine', timeoutMs: 600000 }],
    'project',
  );
  assert.deepEqual(r.checks.map((c) => c.command), ['ok', 'fine']);
  assert.deepEqual(r.issues.map((i) => i.index), [0, 1, 3, 4, 5, 6, 7, 8]);
  assert.match(r.issues[2].message, /timeoutMs/);
  assert.match(r.issues[0].message, /command/);
});

test('more than 10 checks: the first 10 are used and one issue says so; a non-array is one issue', () => {
  const many = core.validateChecks(Array.from({ length: 14 }, (_, i) => ({ command: `echo ${i}` })), 'settings');
  assert.equal(many.checks.length, core.MAX_CHECKS);
  assert.equal(many.issues.length, 1);
  const bad = core.validateChecks({ command: 'x' }, 'settings');
  assert.equal(bad.checks.length, 0);
  assert.equal(bad.issues[0].index, null);
});

test('done.json: object with checks and maxFixAttempts; anything else is one issue and no checks', () => {
  const ok = core.validateDoneFile({ checks: [{ name: 'a', command: 'npm test', timeoutMs: 2000 }], maxFixAttempts: 3 });
  assert.deepEqual(ok.issues, []);
  assert.equal(ok.maxFixAttempts, 3);
  for (const raw of [null, [], 'x', 5]) {
    const r = core.validateDoneFile(raw);
    assert.equal(r.checks.length, 0);
    assert.equal(r.issues.length, 1);
  }
  const noChecks = core.validateDoneFile({ maxFixAttempts: 1 });
  assert.equal(noChecks.checks.length, 0);
  assert.equal(noChecks.issues.length, 1);
  for (const v of [-1, 6, 1.5, '2']) {
    const r = core.validateDoneFile({ checks: [], maxFixAttempts: v });
    assert.equal(r.maxFixAttempts, undefined);
    assert.match(r.issues[0].message, /maxFixAttempts/);
  }
  assert.equal(core.validateDoneFile({ checks: [], maxFixAttempts: 0 }).maxFixAttempts, 0);
});

test('parseDoneText accepts plain JSON and fs_read line-numbered text, reports broken JSON and huge files', () => {
  const json = JSON.stringify({ checks: [{ name: 'a', command: 'x' }] }, null, 2);
  const numbered = json.split('\n').map((l, i) => `${String(i + 1).padStart(6)}|${l}\n`).join('');
  assert.equal(core.parseDoneText(json).checks.length, 1);
  assert.equal(core.parseDoneText(numbered).checks.length, 1);
  const bad = core.parseDoneText('{ nope');
  assert.equal(bad.checks.length, 0);
  assert.match(bad.issues[0].message, /Invalid JSON/);
  const big = core.parseDoneText(JSON.stringify({ checks: [], pad: 'x'.repeat(core.MAX_DONE_FILE_BYTES) }));
  assert.match(big.issues[0].message, /larger/);
});

test('settings are normalised: defaults, clamped fix attempts, switch off unless true', () => {
  assert.deepEqual(core.normalizeSettings(null), { checks: [], maxFixAttempts: 2, useProjectFile: false });
  const s = core.normalizeSettings({ checks: [{ command: 'a' }, { command: '' }], maxFixAttempts: 99, useProjectFile: 'yes' });
  assert.deepEqual(s, { checks: [{ name: 'a', command: 'a', timeoutMs: 120000 }], maxFixAttempts: 2, useProjectFile: false });
  assert.equal(core.normalizeSettings({ maxFixAttempts: 0 }).maxFixAttempts, 0);
  assert.equal(core.normalizeSettings({ useProjectFile: true }).useProjectFile, true);
});

test('effective config: project file only with its switch; its maxFixAttempts only then', () => {
  const settings = core.normalizeSettings({ checks: [chk('own')], maxFixAttempts: 1 });
  const file = core.validateDoneFile({ checks: [chk('from-file')], maxFixAttempts: 4 });
  const off = core.effectiveConfig(settings, file, false);
  assert.deepEqual(off.checks.map((c) => c.command), ['own']);
  assert.equal(off.maxFixAttempts, 1);
  const on = core.effectiveConfig(settings, file, true);
  assert.deepEqual(on.checks.map((c) => [c.command, c.source]), [['own', 'settings'], ['from-file', 'project']]);
  assert.equal(on.maxFixAttempts, 4);
  const capped = core.effectiveConfig(core.normalizeSettings({ checks: Array.from({ length: 10 }, (_, i) => chk(`c${i}`)) }), file, true);
  assert.equal(capped.checks.length, 10);
});

// ---------- signature, clipping, text ----------

test('failure signature ignores numbers, timings and ANSI, picks the first failing line, includes the check name', () => {
  const a = core.failureSignature('test', '\x1b[31mRunning 12 tests\x1b[0m\nFAIL src/a.test.ts:10 expected 3 got 4 (12ms)\nmore');
  const b = core.failureSignature('test', 'Running 15 tests\nFAIL src/a.test.ts:44 expected 5 got 9 (130ms)');
  assert.equal(a, b);
  assert.notEqual(a, core.failureSignature('lint', 'FAIL src/a.test.ts:10 expected 3 got 4'));
  assert.notEqual(a, core.failureSignature('test', 'FAIL src/b.test.ts:10 expected 3 got 4'));
  assert.equal(core.failureSignature('t', 'one\ntwo'), 't::one');
  assert.equal(core.failureSignature('t', ''), 't::');
  assert.equal(core.failureSignature('t', 'whatever', true), 't::timed out');
});

test('repeated: only the last three in a row count', () => {
  assert.equal(core.repeated(['a', 'a']), false);
  assert.equal(core.repeated(['a', 'a', 'a']), true);
  assert.equal(core.repeated(['b', 'a', 'a', 'a']), true);
  assert.equal(core.repeated(['a', 'a', 'b', 'a']), false);
});

test('cleanOutput strips escape codes, scrubs secrets and keeps both ends of long output', () => {
  const out = core.cleanOutput('\x1b[31mred\x1b[0m\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n' + 'x'.repeat(20000) + '\nTHE END', 1000);
  assert.ok(out.length < 1100);
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(out, /\x1b/);
  assert.match(out, /omitted/);
  assert.match(out, /THE END$/);
  assert.match(out, /^red/);
});

test('feedback message names the check, how it failed and carries clipped output', () => {
  const m = core.feedbackMessage({ name: 'tests', command: 'npm test', status: 'failed', exitCode: 1, durationMs: 10, output: 'boom '.repeat(2000) }, 1, 2);
  assert.match(m, /^Verification failed: the required check "tests" \(npm test\) exited with code 1\./);
  assert.match(m, /fix attempt 1 of 2/);
  assert.ok(m.length < core.MAX_FEEDBACK_OUTPUT + 500);
  assert.match(core.feedbackMessage({ name: 't', command: 'c', status: 'timeout', exitCode: null, durationMs: 5000, output: '' }, 2, 2), /timed out after 5 s[\s\S]*no output/);
});

test('readReport accepts a stored report and rejects junk', () => {
  const report = { results: [{ name: 'a', command: 'b', status: 'passed', exitCode: 0, durationMs: 1, output: '' }, 7], attempt: 1, maxFixAttempts: 2, outcome: 'passed' };
  assert.equal(core.readReport({ report }).results.length, 1);
  for (const bad of [null, {}, { report: null }, { report: { results: 'x' } }, { report: { ...report, outcome: 'weird' } }, { report: { ...report, attempt: 'x' } }]) assert.equal(core.readReport(bad), null);
});

test('the action log keeps gate entries and drops malformed gate metadata', () => {
  const base = { at: 1, tool: 'gate', summary: 's', status: 'success', source: 'gate' };
  const [a, b] = normalizeActionLog([
    { ...base, id: 'a', gate: { check: 'tests', command: 'npm test', exitCode: 1, attempt: 2, junk: 1 } },
    { ...base, id: 'b', gate: { check: 5 } },
  ]);
  assert.deepEqual(a.gate, { check: 'tests', command: 'npm test', exitCode: 1, attempt: 2 });
  assert.equal(a.source, 'gate');
  assert.equal(b.gate, undefined);
  assert.equal(actionKind('gate'), 'gate');
});

// ---------- store ----------

test('settings are stored per project; the file is read only when its switch is on (or the editor asks)', async () => {
  state.reset();
  const root = mkdtempSync(join(tmpdir(), 'verify-store-'));
  mkdirSync(join(root, '.gustaf'));
  writeFileSync(join(root, '.gustaf/done.json'), JSON.stringify({ checks: [chk('from-file')] }));
  const other = mkdtempSync(join(tmpdir(), 'verify-store-'));
  await saveVerificationSettings(root, { checks: [chk('own', { timeoutMs: 3000 })], maxFixAttempts: 1, useProjectFile: false });
  assert.deepEqual((await loadVerificationConfig(root)).checks.map((c) => c.command), ['own']);
  assert.deepEqual((await loadVerificationConfig(other)).checks, []);
  const editor = await loadVerificationView(root, { readFile: true });
  assert.equal(editor.file.checks.length, 1, 'the editor can show the file');
  assert.equal(editor.config.checks.length, 1, 'but it is not part of the effective config');
  await saveVerificationSettings(root, { ...editor.settings, useProjectFile: true });
  assert.deepEqual((await loadVerificationConfig(root)).checks.map((c) => c.command), ['own', 'from-file']);
});

test('suggestions come from the installed scripts and never run anything', async () => {
  state.reset();
  const root = mkdtempSync(join(tmpdir(), 'verify-suggest-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'eslint .', test: 'vitest', build: 'x' } }));
  const found = await suggestChecks(root);
  assert.deepEqual(found.map((c) => c.command), ['npm run typecheck', 'npm run lint', 'npm test']);
  assert.deepEqual(state.runs, []);
  const empty = mkdtempSync(join(tmpdir(), 'verify-suggest-'));
  assert.deepEqual(await suggestChecks(empty), []);
});

// ---------- the agent loop ----------

let n = 0;
const call = (name, args) => ({ type: 'tool_call', id: `c${n++}`, name, args });
const step = (...calls) => ({ parts: calls });
const text = (t) => ({ parts: [{ type: 'text', text: t }] });
const edit = () => call('write_file', { path: `f${n}.txt`, content: 'x' });
const pass = { code: 0, output: 'ok', timed_out: false };
const fail = (output = 'FAIL a.test.ts', code = 1) => ({ code, output, timed_out: false });

/**
 * Runs the agent. o.checks: settings checks (strings become checks); o.file: done.json content; o.enabled: the file switch;
 * o.result: ({ command }) => the fake command result, applied to every command (gate checks and agent commands).
 */
async function run(script, o = {}) {
  state.reset();
  saveRulesConfig(o.config ?? DEFAULT_RULES);
  clearActionLog();
  const root = mkdtempSync(join(tmpdir(), 'verify-test-'));
  mkdirSync(join(root, '.gustaf'));
  writeFileSync(join(root, 'a.txt'), 'hello');
  const checks = (o.checks ?? ['npm test']).map((c) => (typeof c === 'string' ? chk(c) : c));
  await saveVerificationSettings(root, { checks, maxFixAttempts: o.max ?? 2, useProjectFile: !!o.enabled });
  if (o.file !== undefined) writeFileSync(join(root, '.gustaf/done.json'), JSON.stringify(o.file));
  if (o.global) state.settings.set('hooks', JSON.stringify({ hooks: o.global }));
  if (o.result) state.runResult = o.result;
  if (o.hookResult) state.hookResult = o.hookResult;
  const all = [...checks.map((c) => c.command), ...(o.file?.checks ?? []).map((c) => c.command), ...(o.global ?? []).map((h) => h.command)];
  const ctl = new AbortController();
  const approvals = [];
  const stored = [];
  const activities = [];
  const seen = [];
  let i = 0;
  const adapter = {
    supportsComputer: false,
    supportsReasoning: () => false,
    listModels: async () => [],
    turn: async (input) => {
      seen.push(input.messages[input.messages.length - 1]);
      return script[i++] ?? text('done');
    },
  };
  const outcome = await runAgent({
    root,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter,
    providerId: 'p',
    model: 'm',
    access: o.access ?? 'auto',
    mode: o.mode,
    computerUse: false,
    allowlist: o.allowlist ?? ['git status', ...all],
    signal: ctl.signal,
    source: o.source,
    subagent: o.subagent,
    toolNames: o.toolNames,
    chatId: 7,
    onText: () => {},
    onActivity: (a) => activities.push(a),
    onMessage: async (m) => void stored.push(m),
    approve: async (req) => {
      approvals.push(req);
      return o.approve ? o.approve(req) : true;
    },
  });
  const gateLog = getActionLog().entries.filter((e) => e.tool === 'gate');
  const cards = stored.flatMap((m) => m.parts).filter((p) => p.type === 'activity' && p.name === 'verification');
  const feedback = stored.filter((m) => m.role === 'user').map((m) => m.parts[0].text);
  return { root, outcome, approvals, stored, activities, cards, reports: cards.map((c) => c.args.report), feedback, seen, gateLog, log: getActionLog().entries, runs: [...state.runs], timeouts: [...state.runTimeouts], hookRuns: [...state.hookRuns], turns: i };
}
const ran = (r, command) => r.runs.filter((x) => x.command === command);

test('a run that edited no files skips the gate', async () => {
  const none = await run([step(call('read_file', { path: 'a.txt' })), text('looked')]);
  assert.equal(none.runs.length, 0);
  assert.equal(none.cards.length, 0);
  assert.deepEqual(none.outcome, { verification: undefined });
  const talk = await run([text('hi')]);
  assert.equal(talk.runs.length, 0);
  const cmd = await run([step(call('run_command', { command: 'git status' })), text('ok')]);
  assert.deepEqual(cmd.runs.map((x) => x.command), ['git status'], 'a command is not an edit');
  assert.equal(cmd.cards.length, 0);
});

test('a failed edit does not count as an edit', async () => {
  const r = await run([step(call('edit_file', { path: 'a.txt', old_string: 'nope', new_string: 'x' })), text('ok')]);
  assert.equal(r.runs.length, 0);
  assert.equal(r.cards.length, 0);
});

test('no checks configured: nothing runs and the stored messages are the same as without gates', async () => {
  const r = await run([step(edit()), text('done')], { checks: [] });
  assert.equal(r.runs.length, 0);
  assert.equal(r.cards.length, 0);
  assert.equal(r.stored.length, 3);
});

test('edit then stop: one gate cycle, checks run in the run folder, "Checks passed" card sits with the final message', async () => {
  const r = await run([step(edit(), edit(), edit()), text('all done')], { checks: [chk('npm test', { name: 'tests', timeoutMs: 7000 }), chk('npm run lint', { name: 'lint' })], result: () => pass });
  assert.deepEqual(r.runs, [{ root: r.root, command: 'npm test' }, { root: r.root, command: 'npm run lint' }].map((x) => x), 'once, not per tool call; in order');
  assert.deepEqual(r.timeouts, [7000, 120000]);
  assert.equal(r.reports.length, 1);
  assert.equal(r.reports[0].outcome, 'passed');
  assert.deepEqual(r.reports[0].results.map((c) => [c.name, c.status, c.exitCode]), [['tests', 'passed', 0], ['lint', 'passed', 0]]);
  assert.match(r.cards[0].output, /^Checks passed \(2\)/);
  assert.equal(r.cards[0].status, 'success');
  const last = r.stored[r.stored.length - 1];
  assert.equal(last.role, 'assistant');
  assert.equal(last.parts[0].text, 'all done', 'the final text is still the last message');
  assert.equal(last.parts[last.parts.length - 1].name, 'verification');
  assert.equal(r.turns, 2, 'a passing gate does not cost a model turn');
  assert.deepEqual(r.outcome.verification.outcome, 'passed');
  assert.ok(r.activities.some((a) => a.args.report.outcome === 'running'), 'live progress is reported while it runs');
});

test('fail then feedback then pass', async () => {
  let calls = 0;
  const r = await run([step(edit()), text('done?'), step(edit()), text('fixed')], {
    result: ({ command }) => (command === 'npm test' ? (++calls === 1 ? fail('FAIL a.test.ts\nBearer abcdefghijklmnopqrstuvwxyz0123456789\nexpected 1') : pass) : pass),
  });
  assert.equal(r.feedback.length, 1);
  assert.match(r.feedback[0], /^Verification failed: the required check "npm test" \(npm test\) exited with code 1/);
  assert.match(r.feedback[0], /FAIL a\.test\.ts/);
  assert.doesNotMatch(r.feedback[0], /abcdefghijklmnopqrstuvwxyz/, 'secrets are redacted before they reach the model');
  assert.deepEqual(r.seen[2].parts[0].text, r.feedback[0], 'the model sees the feedback as the next user message');
  assert.deepEqual(r.reports.map((x) => x.outcome), ['retry', 'passed']);
  assert.equal(r.reports[0].results[0].status, 'failed');
  assert.equal(ran(r, 'npm test').length, 2);
  assert.equal(r.outcome.verification.outcome, 'passed');
  assert.equal(r.cards[0].status, 'error');
  assert.equal(r.cards[1].status, 'success');
});

test('the gate runs again only after new edits once it passed', async () => {
  const r = await run([step(edit()), text('a'), step(call('read_file', { path: 'a.txt' })), text('b')], { result: () => pass });
  assert.equal(ran(r, 'npm test').length, 1);
});

test('max fix attempts: after the last failure the run is "failed verification" and stops', async () => {
  let k = 0;
  const r = await run([step(edit()), text('1'), text('2'), text('3'), text('never')], { max: 2, result: () => fail(`FAIL case-${k++}-${'x'.repeat(k)}`) });
  assert.equal(ran(r, 'npm test').length, 3, 'one run plus two fix attempts');
  assert.equal(r.feedback.length, 2);
  assert.deepEqual(r.reports.map((x) => x.outcome), ['retry', 'retry', 'failed']);
  assert.equal(r.reports[2].reason, 'max_attempts');
  assert.equal(r.reports[2].suggestion, undefined);
  assert.equal(r.outcome.verification.outcome, 'failed');
  assert.equal(r.outcome.verification.reason, 'max_attempts');
  assert.match(r.outcome.verification.summary, /Failed verification/);
  assert.equal(r.turns, 4, 'no further turns and no infinite loop');
});

test('maxFixAttempts 0: a failure ends the run at once', async () => {
  const r = await run([step(edit()), text('1'), text('never')], { max: 0, result: () => fail() });
  assert.equal(r.feedback.length, 0);
  assert.equal(ran(r, 'npm test').length, 1);
  assert.equal(r.reports[0].reason, 'max_attempts');
  assert.equal(r.turns, 2);
});

test('kill criteria: the same failure three times in a row stops early and suggests another model', async () => {
  let k = 0;
  const r = await run([step(edit()), text('1'), text('2'), text('3'), text('4'), text('5'), text('never')], { max: 5, result: () => fail(`Running ${k} tests\nFAIL src/a.test.ts:${++k * 7} expected ${k} got ${k + 1} (${k}ms)`) });
  assert.equal(ran(r, 'npm test').length, 3, 'stopped after the third identical failure, not at 5 attempts');
  assert.deepEqual(r.reports.map((x) => x.outcome), ['retry', 'retry', 'failed']);
  assert.equal(r.reports[2].reason, 'repeated');
  assert.equal(r.reports[2].suggestion, 'another_model');
  assert.equal(r.outcome.verification.reason, 'repeated');
  assert.match(r.cards[2].output, /same failure three times/);
  assert.equal(r.turns, 4);
});

test('kill criteria need consecutive repeats: a different failure in between resets the streak', async () => {
  const outputs = ['FAIL a', 'FAIL a', 'FAIL b', 'FAIL a', 'FAIL a', 'FAIL b'];
  let k = 0;
  const r = await run([step(edit()), text('1'), text('2'), text('3'), text('4'), text('5'), text('6'), text('never')], { max: 5, result: () => fail(outputs[k++]) });
  assert.equal(ran(r, 'npm test').length, 6, 'five fix attempts, then the budget ends it');
  assert.equal(r.reports[5].reason, 'max_attempts');
  assert.equal(r.reports.some((x) => x.suggestion), false);
});

test('a denied check is reported, never run and not sent back to the agent', async () => {
  const config = normalizeRulesConfig({ rules: [{ effect: 'deny', match: 'prefix', pattern: 'npm test' }] });
  const r = await run([step(edit()), text('done'), text('never')], { config });
  assert.deepEqual(r.runs, []);
  assert.equal(r.feedback.length, 0);
  assert.equal(r.reports[0].outcome, 'failed');
  assert.equal(r.reports[0].reason, 'blocked');
  assert.equal(r.reports[0].results[0].status, 'denied');
  assert.equal(r.gateLog[0].status, 'blocked');
  assert.equal(r.outcome.verification.reason, 'blocked');
  assert.equal(r.turns, 2);
});

test('built-in protections also apply to check commands', async () => {
  const r = await run([step(edit()), text('done')], { checks: ['rm -rf /'], allowlist: ['rm'] });
  assert.deepEqual(r.runs, []);
  assert.equal(r.reports[0].results[0].status, 'denied');
});

test('a check that needs approval asks through the normal card; approving runs it', async () => {
  const r = await run([step(edit()), text('done')], { allowlist: [], result: () => pass });
  const asked = r.approvals.find((a) => a.command === 'npm test');
  assert.ok(asked && asked.kind === 'command');
  assert.match(asked.reason, /verification: npm test/);
  assert.equal(r.runs.length, 1);
  assert.equal(r.gateLog[0].approval, 'user');
  assert.equal(r.reports[0].outcome, 'passed');
});

test('declining the approval card: the check is not run, the run is "failed verification" and it is not asked again', async () => {
  const r = await run([step(edit()), text('done'), step(edit()), text('again'), text('never')], { allowlist: [], approve: () => false });
  assert.deepEqual(r.runs, []);
  assert.equal(r.approvals.filter((a) => a.command === 'npm test').length, 1);
  assert.equal(r.reports[0].reason, 'declined');
  assert.equal(r.gateLog[0].status, 'declined');
  assert.equal(r.feedback.length, 0);
  assert.equal(r.outcome.verification.reason, 'declined');
  assert.equal(r.turns, 2);
});

test('a timed-out check is a failure: fed back as a timeout with the configured limit', async () => {
  const r = await run([step(edit()), text('1'), text('2')], { max: 1, checks: [chk('npm test', { timeoutMs: 5000 })], result: () => ({ code: null, output: '', timed_out: true }) });
  assert.deepEqual(r.timeouts, [5000, 5000]);
  assert.match(r.feedback[0], /timed out/);
  assert.equal(r.reports[0].results[0].status, 'timeout');
  assert.equal(r.gateLog[0].gate.timedOut, true);
  assert.equal(r.gateLog[0].status, 'error');
  assert.match(r.gateLog[0].detail, /Timed out/);
  assert.equal(r.reports[1].outcome, 'failed');
});

test('checks run sequentially and stop at the first one that does not pass', async () => {
  const r = await run([step(edit()), text('1'), text('2')], { max: 0, checks: ['first', 'second', 'third'], result: ({ command }) => (command === 'second' ? fail('FAIL second') : pass) });
  assert.deepEqual(r.runs.map((x) => x.command), ['first', 'second']);
  assert.deepEqual(r.reports[0].results.map((c) => c.status), ['passed', 'failed', 'skipped']);
});

test('output is bounded in the card and in the feedback', async () => {
  const r = await run([step(edit()), text('1'), text('2')], { max: 1, result: () => fail('E'.repeat(200000)) });
  assert.ok(r.reports[0].results[0].output.length <= core.MAX_CHECK_OUTPUT + 80);
  assert.ok(r.feedback[0].length < core.MAX_FEEDBACK_OUTPUT + 600);
  assert.ok(r.gateLog[0].detail.length <= 240);
});

test('the action log has one gate entry per check run with source, check, command, exit code and duration', async () => {
  let k = 0;
  const r = await run([step(edit()), text('1'), text('2')], { checks: [chk('npm test', { name: 'tests' })], result: () => (++k === 1 ? fail('FAIL x', 3) : pass) });
  assert.equal(r.gateLog.length, 2);
  const [a, b] = r.gateLog;
  assert.equal(a.source, 'gate');
  assert.equal(a.tool, 'gate');
  assert.deepEqual({ check: a.gate.check, command: a.gate.command, exitCode: a.gate.exitCode, attempt: a.gate.attempt }, { check: 'tests', command: 'npm test', exitCode: 3, attempt: 1 });
  assert.equal(a.status, 'error');
  assert.match(a.detail, /FAIL x/);
  assert.equal(typeof a.durationMs, 'number');
  assert.equal(a.root, r.root);
  assert.equal(b.status, 'success');
  assert.equal(b.gate.exitCode, 0);
  assert.equal(b.gate.attempt, 2);
  assert.equal(a.approval, 'rule');
});

test('gate commands never trigger hooks; stop hooks run before the gate', async () => {
  const hook = (event, command, extra = {}) => ({ event, command, ...extra });
  const r = await run([step(edit()), text('done')], {
    global: [hook('pre_tool', 'pre.sh'), hook('post_tool', 'post.sh'), hook('post_edit', 'postedit.sh'), hook('stop', 'stop.sh')],
    result: () => pass,
  });
  const hookCommands = r.hookRuns.map((x) => x.command);
  assert.ok(!hookCommands.includes('npm test'), 'the check is not a hook');
  assert.deepEqual(r.hookRuns.map((x) => x.env.GUSTAF_EVENT), ['pre_tool', 'post_tool', 'post_edit', 'stop'], 'tool hooks for the one edit only, none for the check');
  assert.equal(ran(r, 'npm test').length, 1);
  const order = r.log.filter((e) => e.tool === 'hook' || e.tool === 'gate').map((e) => e.tool + ':' + (e.hook?.event ?? ''));
  assert.deepEqual(order, ['hook:pre_tool', 'hook:post_tool', 'hook:post_edit', 'hook:stop', 'gate:']);
});

test('a stop hook that sends the agent back (exit 2) comes first: the gate waits for the next stop', async () => {
  const r = await run([step(edit()), text('first'), text('second')], {
    global: [{ event: 'stop', command: 'verify.sh' }],
    hookResult: () => ({ code: 2, output: 'tests still fail', timed_out: false }),
    result: () => pass,
  });
  assert.equal(r.hookRuns.length, 1, 'stop hooks run once after a re-run request');
  assert.equal(r.feedback.length, 1);
  assert.match(r.feedback[0], /tests still fail/);
  assert.equal(ran(r, 'npm test').length, 1, 'the gate ran once, at the second stop');
  assert.equal(r.cards.length, 1);
  const withCard = r.stored.findIndex((m) => m.parts.some((p) => p.name === 'verification'));
  assert.equal(r.stored[withCard].parts[0].text, 'second');
  const order = r.log.filter((e) => e.tool === 'hook' || e.tool === 'gate').map((e) => e.tool);
  assert.deepEqual(order, ['hook', 'gate']);
});

test('project file: ignored with the switch off (also for scheduled runs), used with it on', async () => {
  const file = { checks: [chk('from-file')], maxFixAttempts: 0 };
  const off = await run([step(edit()), text('done')], { checks: [], file, result: () => pass });
  assert.deepEqual(off.runs, []);
  assert.equal(off.cards.length, 0);
  const scheduledOff = await run([step(edit()), text('done')], { checks: [], file, source: 'scheduled', result: () => pass });
  assert.deepEqual(scheduledOff.runs, []);
  const on = await run([step(edit()), text('done')], { checks: [], file, enabled: true, result: () => pass });
  assert.deepEqual(on.runs.map((x) => x.command), ['from-file']);
  assert.equal(on.reports[0].maxFixAttempts, 0);
  const scheduledOn = await run([step(edit()), text('done')], { checks: [], file, enabled: true, source: 'scheduled', result: () => pass });
  assert.deepEqual(scheduledOn.runs.map((x) => x.command), ['from-file']);
  assert.equal(scheduledOn.gateLog[0].source, 'gate');
});

test('a broken project file never breaks a run; settings checks still run', async () => {
  state.reset();
  const root = mkdtempSync(join(tmpdir(), 'verify-broken-'));
  mkdirSync(join(root, '.gustaf'));
  writeFileSync(join(root, '.gustaf/done.json'), '{ nope');
  await saveVerificationSettings(root, { checks: [chk('npm test')], maxFixAttempts: 2, useProjectFile: true });
  const view = await loadVerificationView(root);
  assert.deepEqual(view.config.checks.map((c) => c.command), ['npm test']);
  assert.equal(view.config.issues.length, 1);
});

test('Plan and Ask mode, read-only access and read-only subagent types never run gates', async () => {
  for (const mode of ['plan', 'ask']) {
    const r = await run([step(edit()), text('done')], { mode, result: () => pass });
    assert.deepEqual(r.runs, [], mode);
    assert.equal(r.cards.length, 0);
  }
  const readonly = await run([step(edit()), text('done')], { access: 'readonly', result: () => pass });
  assert.deepEqual(readonly.runs, []);
  assert.equal(readonly.cards.length, 0);
  const explore = await run([step(edit()), text('done')], { subagent: true, toolNames: ['read_file', 'list_dir', 'search'], result: () => pass });
  assert.deepEqual(explore.runs, []);
  assert.equal(explore.cards.length, 0);
});

test('a general subagent (may edit) runs its own gate with the same limits', async () => {
  let k = 0;
  const r = await run([step(edit()), text('1'), text('2'), text('3'), text('4')], { subagent: true, max: 1, result: () => fail(`FAIL ${k++}${'z'.repeat(k)}`) });
  assert.equal(ran(r, 'npm test').length, 2);
  assert.equal(r.outcome.verification.outcome, 'failed');
  const ok = await run([step(edit()), text('done')], { subagent: true, result: () => pass });
  assert.equal(ok.outcome.verification.outcome, 'passed');
});

test('aborting during the gate stops it, stores the message and does not continue', async () => {
  state.reset();
  saveRulesConfig(DEFAULT_RULES);
  const root = mkdtempSync(join(tmpdir(), 'verify-abort-'));
  await saveVerificationSettings(root, { checks: [chk('first'), chk('second')], maxFixAttempts: 2, useProjectFile: false });
  const ctl = new AbortController();
  state.runResult = () => {
    ctl.abort();
    return pass;
  };
  const stored = [];
  let turns = 0;
  const script = [step(call('write_file', { path: 'x.txt', content: '1' })), text('done'), text('never')];
  await runAgent({
    root,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: { supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: async () => script[turns++] },
    providerId: 'p',
    model: 'm',
    access: 'auto',
    computerUse: false,
    allowlist: ['first', 'second'],
    signal: ctl.signal,
    onText: () => {},
    onMessage: async (m) => void stored.push(m),
    approve: async () => true,
  });
  assert.deepEqual(state.runs.map((x) => x.command), ['first'], 'the second check is not started after the abort');
  assert.equal(turns, 2);
  const last = stored[stored.length - 1];
  assert.equal(last.parts[0].text, 'done', 'the final message was still stored');
});

test('clarifications that arrive at the stop store the message first and run no gate yet', async () => {
  state.reset();
  saveRulesConfig(DEFAULT_RULES);
  const root = mkdtempSync(join(tmpdir(), 'verify-clar-'));
  await saveVerificationSettings(root, { checks: [chk('npm test')], maxFixAttempts: 2, useProjectFile: false });
  state.runResult = pass;
  const queue = [[], [], [{ role: 'user', parts: [{ type: 'text', text: 'one more thing' }] }], []];
  const stored = [];
  let turns = 0;
  const script = [step(call('write_file', { path: 'x.txt', content: '1' })), text('done'), text('really done')];
  await runAgent({
    root,
    history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }],
    adapter: { supportsComputer: false, supportsReasoning: () => false, listModels: async () => [], turn: async () => script[turns++] },
    providerId: 'p',
    model: 'm',
    access: 'auto',
    computerUse: false,
    allowlist: ['npm test'],
    signal: new AbortController().signal,
    takeClarifications: async () => queue.shift() ?? [],
    onText: () => {},
    onMessage: async (m) => void stored.push(m),
    approve: async () => true,
  });
  assert.equal(state.runs.length, 1, 'the gate runs once, at the final stop');
  const order = stored.map((m) => m.role + ':' + (m.parts[0]?.text ?? m.parts[0]?.type));
  assert.deepEqual(order.slice(-3), ['assistant:done', 'user:one more thing', 'assistant:really done']);
  assert.equal(stored[stored.length - 1].parts.at(-1).name, 'verification');
});
