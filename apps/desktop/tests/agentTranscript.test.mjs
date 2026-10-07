// Pure helpers of the persisted subagent transcript: bounding a message, rows back to steps, the continuation seed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const t = await import('../src/agent/agentTranscript.ts');

const row = (seq, role, parts) => ({
  seq,
  role,
  parts_json: typeof parts === 'string' ? parts : JSON.stringify(parts),
  created_at: seq,
});

test('a stored message is bounded per field and in total, without images or activities', () => {
  const long = 'x'.repeat(50_000);
  const parts = [
    { type: 'text', text: long },
    { type: 'image', data: 'AAAA' },
    { type: 'activity', id: 'a', name: 'n', args: {}, status: 'success' },
    { type: 'tool_call', id: 'c', name: 'run_command', args: { command: long }, computer: { actions: [] } },
    { type: 'tool_result', id: 'c', name: 'run_command', output: long, image: 'BBBB', isError: true },
  ];
  const json = t.messageJson(parts);
  assert.ok(json.length <= t.MAX_MESSAGE_JSON);
  const back = JSON.parse(json);
  assert.deepEqual(
    back.map((p) => p.type),
    ['text', 'text', 'tool_call', 'tool_result'],
  );
  assert.equal(back[1].text, '[image omitted]');
  assert.ok(back[0].text.length <= t.MAX_TEXT_PART);
  assert.ok(back[2].args.truncated.length <= t.MAX_ARGS_JSON);
  assert.equal(back[3].isError, true);
  assert.ok(!('image' in back[3]) && !('computer' in back[2]));
  // Many large parts still fit and stay valid JSON.
  const many = Array.from({ length: 40 }, () => ({ type: 'text', text: long }));
  const big = t.messageJson(many);
  assert.ok(big.length <= t.MAX_MESSAGE_JSON);
  assert.equal(JSON.parse(big).length, t.MAX_PARTS_PER_MESSAGE);
  // Small messages are stored as they are (arguments stay objects).
  assert.deepEqual(
    JSON.parse(t.messageJson([{ type: 'tool_call', id: '1', name: 'read_file', args: { path: 'a' } }])),
    [{ type: 'tool_call', id: '1', name: 'read_file', args: { path: 'a' } }],
  );
});

test('secrets are scrubbed before a message is stored', () => {
  const json = t.messageJson([
    {
      type: 'tool_call',
      id: '1',
      name: 'run_command',
      args: { command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456" x' },
    },
    { type: 'text', text: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
  ]);
  assert.doesNotMatch(json, /sk-abcdefghij|ghp_abcdefghij/);
});

test('rows become steps: prompt, text, each tool call with its result, notes, migrated steps', () => {
  const steps = t.rowsToSteps([
    row(0, 'user', [{ type: 'text', text: 'the task' }]),
    row(1, 'assistant', [
      { type: 'text', text: 'looking' },
      { type: 'tool_call', id: 'a', name: 'read_file', args: { path: 'x.ts' } },
      { type: 'tool_call', id: 'b', name: 'list_dir', args: { path: 'src' } },
    ]),
    row(2, 'tool', [
      { type: 'tool_result', id: 'a', name: 'read_file', output: 'content' },
      { type: 'tool_result', id: 'b', name: 'list_dir', output: 'boom', isError: true },
    ]),
    row(3, 'assistant', [{ type: 'tool_call', id: 'c', name: 'search', args: { pattern: 'q' } }]),
    row(4, 'note', [{ type: 'text', text: 'Stopped at its step limit (3).', error: true }]),
    row(5, 'step', { at: 9, kind: 'tool', tool: 'old', text: 'legacy', result: 'r' }),
    row(6, 'assistant', 'not json'),
    row(7, 'tool', [{ type: 'tool_result', id: 'zzz', name: 'orphan', output: 'o' }]),
  ]);
  assert.deepEqual(
    steps.map((s) => [s.kind, s.tool, s.text, s.result, !!s.error]),
    [
      ['note', undefined, 'the task', undefined, false],
      ['text', undefined, 'looking', undefined, false],
      ['tool', 'read_file', 'x.ts', 'content', false],
      ['tool', 'list_dir', 'src', 'boom', true],
      ['tool', 'search', 'q', undefined, false],
      ['note', undefined, 'Stopped at its step limit (3).', undefined, true],
      ['tool', 'old', 'legacy', 'r', false],
      ['tool', 'orphan', 'orphan', 'o', false],
    ],
  );
});

test('only finished, failed and limit/budget-stopped runs can be continued', () => {
  for (const s of ['completed', 'failed', 'limit', 'budget']) assert.equal(t.canContinue(s), true, s);
  for (const s of ['queued', 'running', 'cancelled', 'interrupted']) assert.equal(t.canContinue(s), false, s);
});

test('the continuation prompt summarizes the earlier run, is bounded, and ends with the follow-up', () => {
  const steps = Array.from({ length: 100 }, (_, i) => ({
    at: i,
    kind: 'tool',
    tool: 'read_file',
    text: `f${i}.ts`,
    ...(i === 99 ? { error: true } : {}),
  }));
  const p = t.continuationPrompt(
    {
      title: 'Scout',
      type: 'explore',
      status: 'limit',
      error: 'Stopped at its step limit (20)',
      task: 'find the bug '.repeat(500),
      report: 'found it '.repeat(900),
      steps,
    },
    'now fix the typo',
  );
  assert.match(p, /earlier subagent run "Scout" \(explore, limit: Stopped at its step limit \(20\)\)/);
  assert.match(p, /Earlier tool calls \(100, newest 40 shown\)/);
  assert.match(p, /- read_file f99\.ts \(failed\)/);
  assert.doesNotMatch(p, /f59\.ts/);
  assert.ok(p.indexOf('f60.ts') > 0);
  assert.ok(p.endsWith('--- Follow-up (your task now) ---\nnow fix the typo'));
  assert.ok(p.length < t.MAX_SEED_CHARS + 200);
  assert.match(
    t.continuationPrompt({ title: 'T', type: 'plan', status: 'failed', steps: [] }, ' go '),
    /\(not available\)[\s\S]*\(none\)[\s\S]*produced no report[\s\S]*\ngo$/,
  );
  assert.match(
    t.continueRequest({ id: 'r-1', title: 'Scout', type: 'explore' }, ' do more '),
    /continue_from "r-1" and type "explore".*\ndo more$/s,
  );
});
