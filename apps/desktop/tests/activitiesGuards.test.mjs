import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeActivities } from '../src/providers/activities.ts';

test('malformed or non-object CLI events yield no activities instead of throwing', () => {
  for (const provider of ['claude', 'codex', 'cursor-agent', 'other']) {
    for (const ev of [
      undefined,
      null,
      'text',
      42,
      [],
      {},
      { message: 'x' },
      { message: { content: 'not a list' } },
      { item: 'x', type: 'item.completed' },
    ]) {
      const out = nativeActivities(provider, ev);
      assert.ok(Array.isArray(out));
    }
  }
  assert.deepEqual(nativeActivities('claude', { message: { content: [null, 'x', { type: 'text', text: 'hi' }] } }), []);
});

test('Claude tool_use keeps object input and falls back to empty args', () => {
  const [a, b] = nativeActivities('claude', {
    message: {
      content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', id: 't2', name: 'Noop' },
      ],
    },
  });
  assert.deepEqual(a, { type: 'activity', id: 't1', name: 'Bash', args: { command: 'ls' }, status: 'running' });
  assert.deepEqual(b.args, {});
  const [err] = nativeActivities('claude', {
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: { a: 1 } }] },
  });
  assert.equal(err.status, 'error');
  assert.equal(err.output, JSON.stringify({ a: 1 }, null, 2));
});

test('Codex file changes become a path list and running items stay running', () => {
  const [done] = nativeActivities('codex', {
    type: 'item.completed',
    item: { id: 'p', type: 'file_change', status: 'completed', changes: [{ path: 'a.ts' }, { path: 'b.ts' }] },
  });
  assert.equal(done.args.path, 'a.ts, b.ts');
  assert.equal(done.status, 'success');
  const [running] = nativeActivities('codex', {
    type: 'item.started',
    item: { id: 'c', type: 'command_execution', command: 'ls' },
  });
  assert.equal(running.status, 'running');
  assert.equal(running.args.path, undefined);
  assert.equal(nativeActivities('codex', { type: 'item.completed', item: { type: 'agent_message' } }).length, 0);
  assert.equal(
    nativeActivities('codex', { type: 'thread.started', item: { id: 'x', type: 'command_execution' } }).length,
    0,
  );
});

test('Cursor tool calls strip the ToolCall suffix, derive ids and report errors', () => {
  const [started] = nativeActivities('cursor-agent', {
    type: 'tool_call',
    subtype: 'started',
    tool_call: { readToolCall: { args: { path: 'x' } } },
  });
  assert.equal(started.name, 'read');
  assert.equal(started.status, 'running');
  assert.equal(started.id, 'readToolCall:{"path":"x"}');
  const [failed] = nativeActivities('cursor-agent', {
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'k',
    tool_call: { shellToolCall: { args: {}, result: { error: 'boom' } } },
  });
  assert.equal(failed.id, 'k');
  assert.equal(failed.status, 'error');
  const [fallback] = nativeActivities('cursor-agent', { type: 'tool_call', subtype: 'completed', call_id: 'z' });
  assert.equal(fallback.name, 'tool');
  assert.equal(fallback.status, 'unknown');
});
