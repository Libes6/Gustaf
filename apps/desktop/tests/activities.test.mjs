import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeActivities, mergeActivity } from '../src/providers/activities.ts';
test('Codex records command output, failed exit codes and real integration errors', () => {
  const [command] = nativeActivities('codex', {
    type: 'item.completed',
    item: { id: '1', type: 'command_execution', command: 'npm test', exit_code: 1, aggregated_output: 'Test failed' },
  });
  assert.equal(command.type, 'activity');
  assert.equal(command.status, 'error');
  assert.equal(command.output, 'Test failed');
  const [mcp] = nativeActivities('codex', {
    type: 'item.completed',
    item: { id: '2', type: 'mcp_tool_call', server: 'browser', tool: 'open', error: { message: 'Permission denied' } },
  });
  assert.equal(mcp.status, 'error');
  assert.match(mcp.output, /Permission denied/);
  assert.equal(nativeActivities('codex', { type: 'item.completed', item: { type: 'reasoning' } }).length, 0);
});
test('Claude tool results retain original name and arguments without becoming executable calls', () => {
  const [start] = nativeActivities('claude', {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'read1', name: 'Read', input: { file_path: 'app.ts' } }] },
  });
  const [end] = nativeActivities('claude', {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'read1', content: 'file contents' }] },
  });
  const merged = mergeActivity(start, end);
  assert.equal(merged.name, 'Read');
  assert.equal(merged.args.file_path, 'app.ts');
  assert.equal(merged.status, 'success');
  assert.equal(merged.type, 'activity');
});
test('unknown Cursor result is not marked successful', () => {
  const [action] = nativeActivities('cursor-agent', {
    type: 'tool_call',
    subtype: 'completed',
    call_id: 'c1',
    tool_call: { shellToolCall: { args: { command: 'pwd' } } },
  });
  assert.equal(action.status, 'unknown');
  assert.equal(action.args.command, 'pwd');
});
