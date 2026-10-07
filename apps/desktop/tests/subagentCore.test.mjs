import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const core = await import('../src/agent/subagentCore.ts');
const { READ_TOOLS, WRITE_TOOLS } = await import('../src/agent/tools.ts');
const ALL = [...READ_TOOLS, ...WRITE_TOOLS, core.SPAWN_TOOL];

test('spawn_agent arguments are validated and normalized', () => {
  const ok = core.parseSpawnArgs({
    title: '  Find   usages ',
    prompt: ' look ',
    type: 'explore',
    files: ['./a.ts', 'a.ts', 'src/b.ts', '../secret', '/etc/passwd', 5, 'x/../y'],
  });
  assert.deepEqual(ok, {
    ok: true,
    value: { title: 'Find usages', prompt: 'look', type: 'explore', files: ['a.ts', 'src/b.ts'] },
  });
  assert.equal(core.parseSpawnArgs({ title: 'x', prompt: 'y', type: 'root' }).ok, false);
  assert.equal(core.parseSpawnArgs({ title: '', prompt: 'y', type: 'plan' }).ok, false);
  assert.equal(core.parseSpawnArgs({ title: 'x', prompt: '  ', type: 'plan' }).ok, false);
  assert.equal(core.parseSpawnArgs({ title: 'x', prompt: 'a'.repeat(core.MAX_PROMPT + 1), type: 'plan' }).ok, false);
  assert.equal(core.parseSpawnArgs(null).ok, false);
  // least privilege when the type is missing
  assert.equal(core.parseSpawnArgs({ title: 'x', prompt: 'y' }).value.type, 'explore');
  assert.equal(
    core.parseSpawnArgs({ title: 'x'.repeat(500), prompt: 'y', type: 'general' }).value.title.length,
    core.MAX_TITLE,
  );
  assert.equal(
    core.parseSpawnArgs({ title: 'x', prompt: 'y', type: 'plan', files: Array.from({ length: 50 }, (_, i) => `f${i}`) })
      .value.files.length,
    core.MAX_FILES,
  );
});

test('read-only types get only the read tools; general gets everything but spawn_agent', () => {
  for (const t of ['explore', 'plan', 'review']) {
    assert.equal(core.isReadOnlyType(t), true);
    assert.deepEqual(
      core.filterTools(t, ALL).map((d) => d.name),
      ['read_file', 'list_dir', 'search'],
    );
    assert.deepEqual(core.allowedToolNames(t), ['read_file', 'list_dir', 'search']);
  }
  assert.equal(core.isReadOnlyType('general'), false);
  assert.deepEqual(
    core.filterTools('general', ALL).map((d) => d.name),
    ['read_file', 'list_dir', 'search', 'diagnostics', 'edit_file', 'write_file', 'run_command'],
  );
  assert.equal(core.allowedToolNames('general'), null);
});

test('budgets: defaults per type, validated overrides, hard caps', () => {
  assert.deepEqual(core.resolveBudget('explore'), core.DEFAULT_BUDGETS.explore);
  assert.ok(core.resolveBudget('general').maxSteps > core.resolveBudget('explore').maxSteps);
  assert.equal(core.resolveBudget('plan', { plan: { maxSteps: 3 } }).maxSteps, 3);
  assert.equal(
    core.resolveBudget('plan', { plan: { maxSteps: -1, maxMs: NaN } }).maxSteps,
    core.DEFAULT_BUDGETS.plan.maxSteps,
  );
  assert.equal(core.resolveBudget('plan', { plan: { maxSteps: 1e9 } }).maxSteps, 100);
  assert.equal(core.resolveBudget('plan', { explore: { maxSteps: 1 } }).maxSteps, core.DEFAULT_BUDGETS.plan.maxSteps);
});

test('budget breach: each limit, exact limit is allowed', () => {
  const b = { maxSteps: 3, maxToolCalls: 5, maxMs: 1000, maxTokens: 100 };
  const use = { steps: 3, toolCalls: 5, tokens: 100, startedAt: 0 };
  assert.equal(core.budgetBreach(use, b, 1000), null);
  assert.equal(core.budgetBreach({ ...use, steps: 4 }, b, 0), 'steps');
  assert.equal(core.budgetBreach({ ...use, toolCalls: 6 }, b, 0), 'toolCalls');
  assert.equal(core.budgetBreach({ ...use, tokens: 101 }, b, 0), 'tokens');
  assert.equal(core.budgetBreach(use, b, 1001), 'time');
  assert.match(core.breachMessage('toolCalls', b), /tool call limit \(5\)/);
});

test('overlap detection between changed file sets', () => {
  const a = { id: 'a', label: 'Agent A', files: ['src/x.ts', 'src/y.ts'] };
  const b = { id: 'b', label: 'Agent B', files: ['src/y.ts', 'z.ts'] };
  const c = { id: 'c', label: 'Agent C', files: ['other.ts'] };
  assert.deepEqual(core.findOverlaps(a, [a, b, c]), [{ id: 'b', label: 'Agent B', files: ['src/y.ts'] }]);
  assert.deepEqual(core.findOverlaps(c, [a, b]), []);
  assert.equal(core.overlapWarning([]), '');
  const w = core.overlapWarning(core.findOverlaps(a, [b]));
  assert.match(w, /Agent B/);
  assert.match(w, /src\/y\.ts/);
  const many = core.overlapWarning([{ id: 'q', label: 'Q', files: ['1', '2', '3', '4', '5', '6', '7'] }]);
  assert.match(many, /\+2 more/);
});

test('report truncation is bounded and says so', () => {
  assert.equal(core.truncateReport('  short  '), 'short');
  const long = core.truncateReport('x'.repeat(50_000), 1000);
  assert.ok(long.length <= 1000 + 60);
  assert.match(long, /report truncated/);
  const r = core.buildReport({ title: 'T', type: 'explore', status: 'completed', text: 'y'.repeat(50_000) });
  assert.ok(r.length < core.MAX_REPORT_CHARS + 400);
});

test('report states outcome, changed files and warnings', () => {
  const done = core.buildReport({
    title: 'Fix',
    type: 'general',
    status: 'completed',
    text: 'did it',
    changed: ['a.ts'],
    warnings: ['Warning: overlap'],
  });
  assert.match(done, /^Subagent "Fix" \(general\) finished\./);
  assert.match(done, /did it/);
  assert.match(done, /Changed files \(1.*a\.ts/);
  assert.match(done, /Warning: overlap/);
  assert.match(
    core.buildReport({ title: 'F', type: 'general', status: 'completed', text: 'nothing' }),
    /No files were changed/,
  );
  assert.match(
    core.buildReport({ title: 'F', type: 'explore', status: 'limit', reason: 'step limit (3)', text: 'partial' }),
    /stopped at its step limit \(3\)/,
  );
  assert.match(core.buildReport({ title: 'F', type: 'explore', status: 'cancelled', text: '' }), /was cancelled/);
  assert.match(
    core.buildReport({ title: 'F', type: 'explore', status: 'failed', reason: 'HTTP 500', text: '' }),
    /failed: HTTP 500/,
  );
  assert.match(core.buildReport({ title: 'F', type: 'explore', status: 'completed', text: '' }), /\(no report text\)/);
});

test('serializeCalls runs one at a time in call order and survives rejections', async () => {
  const order = [];
  let live = 0;
  let max = 0;
  const fn = core.serializeCalls(async (n) => {
    live++;
    max = Math.max(max, live);
    order.push(`start${n}`);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    if (n === 1) throw new Error('no');
    return n;
  });
  const results = await Promise.allSettled([fn(0), fn(1), fn(2)]);
  assert.equal(max, 1);
  assert.deepEqual(order, ['start0', 'start1', 'start2']);
  assert.deepEqual(
    results.map((r) => r.status),
    ['fulfilled', 'rejected', 'fulfilled'],
  );
});

test('subagent system prompt carries the type role and the focus files', () => {
  assert.match(core.subagentSystem('explore', []), /read-only/);
  assert.match(core.subagentSystem('general', ['a.ts', 'b.ts']), /private copy/);
  assert.match(core.subagentSystem('general', ['a.ts', 'b.ts']), /Focus on: a\.ts, b\.ts/);
});
