import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeActivities, applyActivity } from '../src/providers/activities.ts';
import { parseClaudeEvent } from '../src/providers/claudeCli.ts';

// Synthetic fixtures: the Codex exec event is assumed to mirror the app-server `collabAgentToolCall` item (docs/features/agents.md).
const codexEvent = (type, item) => ({ type, item: { type: 'collab_tool_call', sender_thread_id: 'main', receiver_thread_ids: [], agents_states: {}, status: 'in_progress', ...item } });
const feed = (provider, events) => {
  const map = new Map();
  for (const e of events) for (const a of nativeActivities(provider, e)) applyActivity(map, a);
  return [...map.values()];
};

test('Codex spawn becomes one subagent entry titled from its prompt and keyed by the new thread id afterwards', () => {
  const out = feed('codex', [
    codexEvent('item.started', { id: 'i1', tool: 'spawn_agent', prompt: 'Review the parser\nand list the bugs' }),
    codexEvent('item.completed', { id: 'i1', tool: 'spawn_agent', prompt: 'Review the parser\nand list the bugs', receiver_thread_ids: ['t-abc'], agents_states: { 't-abc': { status: 'pending_init', message: null } }, status: 'completed' }),
  ]);
  assert.equal(out.length, 1);
  const [a] = out;
  assert.equal(a.type, 'activity');
  assert.equal(a.subagent.provider, 'codex');
  assert.equal(a.subagent.agentId, 't-abc');
  assert.equal(a.subagent.title, 'Review the parser');
  assert.equal(a.subagent.state, 'running');
  assert.equal(a.status, 'running');
  assert.match(a.subagent.prompt, /Review the parser and list the bugs/);
});

test('five wait calls on one agent merge into a single entry with a counter and the final message', () => {
  const events = [codexEvent('item.completed', { id: 'i1', tool: 'spawn_agent', prompt: 'Count files', receiver_thread_ids: ['t1'], status: 'completed' })];
  for (let i = 0; i < 5; i++) {
    events.push(codexEvent('item.started', { id: `w${i}`, tool: 'wait', receiver_thread_ids: ['t1'] }));
    const last = i === 4;
    events.push(codexEvent('item.completed', { id: `w${i}`, tool: 'wait', receiver_thread_ids: ['t1'], status: 'completed', agents_states: { t1: last ? { status: 'completed', message: '42 files' } : { status: 'running', message: null } } }));
  }
  const out = feed('codex', events);
  assert.equal(out.length, 1);
  assert.equal(out[0].subagent.waits, 5);
  assert.equal(out[0].subagent.state, 'completed');
  assert.equal(out[0].subagent.result, '42 files');
  assert.equal(out[0].output, '42 files');
  assert.equal(out[0].status, 'success');
  assert.equal(out[0].subagent.title, 'Count files');
});

test('a wait in flight marks the agent as waiting; a wait without receivers attributes agents by agents_states', () => {
  let out = feed('codex', [
    codexEvent('item.completed', { id: 'i1', tool: 'spawn_agent', prompt: 'x', receiver_thread_ids: ['t1'], status: 'completed' }),
    codexEvent('item.started', { id: 'w1', tool: 'wait', receiver_thread_ids: ['t1'] }),
  ]);
  assert.equal(out[0].subagent.state, 'waiting');
  assert.equal(out[0].status, 'running');
  assert.deepEqual(nativeActivities('codex', codexEvent('item.started', { id: 'w2', tool: 'wait' })), []);
  out = feed('codex', [codexEvent('item.completed', { id: 'w2', tool: 'wait', status: 'completed', agents_states: { a: { status: 'completed', message: 'one' }, b: { status: 'errored', message: 'boom' } } })]);
  assert.deepEqual(out.map((o) => [o.subagent.agentId, o.subagent.state]), [['a', 'completed'], ['b', 'failed']]);
});

test('terminal state is sticky, send_input resumes, a failed call fails the agent, close completes it', () => {
  const base = [codexEvent('item.completed', { id: 'i1', tool: 'spawn_agent', prompt: 'x', receiver_thread_ids: ['t1'], status: 'completed' })];
  const done = codexEvent('item.completed', { id: 'w', tool: 'wait', receiver_thread_ids: ['t1'], agents_states: { t1: { status: 'completed', message: 'ok' } } });
  assert.equal(feed('codex', [...base, done, codexEvent('item.started', { id: 'w9', tool: 'wait', receiver_thread_ids: ['t1'] })])[0].subagent.state, 'completed');
  assert.equal(feed('codex', [...base, done, codexEvent('item.completed', { id: 's', tool: 'send_input', prompt: 'more', receiver_thread_ids: ['t1'], status: 'completed' })])[0].subagent.state, 'running');
  assert.equal(feed('codex', [...base, codexEvent('item.completed', { id: 'f', tool: 'wait', receiver_thread_ids: ['t1'], status: 'failed' })])[0].subagent.state, 'failed');
  assert.equal(feed('codex', [...base, codexEvent('item.completed', { id: 'c', tool: 'close_agent', receiver_thread_ids: ['t1'], status: 'completed' })])[0].subagent.state, 'completed');
});

test('camelCase app-server spelling is read too, list_agents is dropped, unknown tools fall back to the generic card', () => {
  const [a] = nativeActivities('codex', { type: 'item.completed', item: { type: 'collabAgentToolCall', id: 'i', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['t9'], agentsStates: { t9: { status: 'running' } }, prompt: 'hi' } });
  assert.equal(a.subagent.agentId, 't9');
  assert.deepEqual(nativeActivities('codex', codexEvent('item.completed', { id: 'l', tool: 'list_agents' })), []);
  const [g] = nativeActivities('codex', codexEvent('item.completed', { id: 'g', tool: 'brand_new_tool', status: 'completed' }));
  assert.equal(g.name, 'collab_tool_call');
  assert.equal(g.subagent, undefined);
});

test('malformed collab items never throw', () => {
  for (const item of [{ type: 'collab_tool_call' }, { type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: 'x', agents_states: 5 }, { type: 'collab_tool_call', tool: 'spawn_agent', prompt: 7, agents_states: { a: null } }]) {
    for (const type of ['item.started', 'item.completed']) assert.ok(Array.isArray(nativeActivities('codex', { type, item })));
  }
});

test('Claude Task call becomes a subagent with its report; Agent is the same tool; inner tool calls are counted, not listed', () => {
  const out = feed('claude', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Task', input: { description: 'Find usages', subagent_type: 'Explore', prompt: 'grep for foo everywhere' } }] } },
    { type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'in1', name: 'Grep', input: { pattern: 'foo' } }] } },
    { type: 'user', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_result', tool_use_id: 'in1', content: 'a.ts:1' }] } },
    { type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'in2', name: 'Read', input: { file_path: 'a.ts' } }] } },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].subagent.state, 'running');
  assert.equal(out[0].subagent.toolUses, 2);
  assert.equal(out[0].subagent.step, 'Read a.ts');
  assert.equal(out[0].subagent.title, 'Find usages');
  assert.equal(out[0].subagent.role, 'Explore');
  const map = new Map();
  for (const e of [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'Plan', subagent_type: 'Plan' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'Step one.\nStep two.' }] }] } },
  ]) for (const a of nativeActivities('claude', e)) applyActivity(map, a);
  const [done] = [...map.values()];
  assert.equal(done.name, 'Agent');
  assert.equal(done.status, 'success');
  assert.equal(done.subagent.state, 'completed');
  assert.equal(done.subagent.result, 'Step one. Step two.');
  assert.equal(done.output, 'Step one.\nStep two.');
});

test('a failed Task result marks the subagent failed; ordinary Claude tools stay generic', () => {
  const out = feed('claude', [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Task', input: { description: 'd' } }, { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: 'crashed' }] } },
  ]);
  assert.equal(out[0].subagent.state, 'failed');
  assert.equal(out[0].status, 'error');
  assert.equal(out[1].subagent, undefined);
  assert.equal(out[1].name, 'Read');
});

test('text streamed inside a Claude subagent is not part of the answer', () => {
  assert.equal(parseClaudeEvent({ type: 'stream_event', parent_tool_use_id: 'tu1', event: { delta: { type: 'text_delta', text: 'inner' } } }).text, undefined);
  assert.equal(parseClaudeEvent({ type: 'stream_event', parent_tool_use_id: null, event: { delta: { type: 'text_delta', text: 'outer' } } }).text, 'outer');
});
