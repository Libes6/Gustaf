// A Codex item that mentions collab or agent is never dropped: when it cannot become a subagent entry it keeps a generic
// card (the whole item as its output) and is reported to the raw CLI log. Several synthetic shapes of the unknown event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { setSetting } = await import('./helpers/apiStub.mjs');
const { nativeActivities, applyActivity } = await import('../src/providers/activities.ts');
const { createRawLogger, rawLogLine, dayOf, rawLogEnabled, MAX_ENTRY_CHARS } = await import('../src/lib/rawCliLog.ts');

const ev = (type, item) => ({ type, item });
const run = (event) => {
  const unmapped = [];
  const out = nativeActivities('codex', event, (u) => unmapped.push(u));
  return { out, unmapped };
};

test('snake_case spawn with every field maps to a subagent and is not reported', () => {
  const { out, unmapped } = run(ev('item.started', { id: 'i1', type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'Look at the parser', receiver_thread_ids: [], agents_states: {}, status: 'in_progress' }));
  assert.equal(out.length, 1);
  assert.equal(out[0].subagent.state, 'running');
  assert.deepEqual(unmapped, []);
});

test('camelCase item with an unknown tool name falls back to a generic card holding the whole item', () => {
  const { out, unmapped } = run(ev('item.completed', { id: 'c1', type: 'collabAgentToolCall', tool: 'rebalanceAgents', status: 'completed', receiverThreadIds: ['t1'], prompt: 'x' }));
  assert.equal(out.length, 1);
  assert.equal(out[0].subagent, undefined);
  assert.equal(out[0].name, 'collabAgentToolCall');
  assert.equal(out[0].status, 'success');
  assert.match(out[0].output, /rebalanceAgents/);
  assert.deepEqual(unmapped.map((u) => [u.type, u.tool, u.reason]), [['collabAgentToolCall', 'rebalanceAgents', 'unknown-tool']]);
});

test('list_agents is a card, not nothing', () => {
  const { out, unmapped } = run(ev('item.completed', { id: 'l1', type: 'collab_tool_call', tool: 'list_agents', status: 'completed', agents_states: { a: { status: 'running' } } }));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'collab_tool_call');
  assert.equal(unmapped[0].reason, 'no-agents');
});

test('a known action that names no agent (wait, send_input, close_agent) keeps its card', () => {
  for (const tool of ['wait', 'send_input', 'close_agent', 'waitAgent', 'interruptAgent']) {
    const { out, unmapped } = run(ev('item.started', { id: `x-${tool}`, type: 'collab_tool_call', tool, status: 'in_progress' }));
    assert.equal(out.length, 1, tool);
    assert.equal(out[0].subagent, undefined, tool);
    assert.equal(out[0].status, 'running', tool);
    assert.equal(unmapped.length, 1, tool);
  }
});

test('missing fields: no tool, no id, no status, wrong types never throw and never give zero cards', () => {
  const shapes = [
    { type: 'collab_tool_call' },
    { type: 'collab_tool_call', tool: null, receiver_thread_ids: 'x', agents_states: 5 },
    { type: 'collab_agent_event', agent_id: 'a1', state: 'running' },
    { type: 'agent_spawned', thread_id: 't1', prompt: { nested: true } },
    { type: 'collab_tool_call', tool: 'spawn_agent', prompt: 7, agents_states: { a: null } },
    { type: 'subagent_status', agents: [{ id: 1 }] },
  ];
  for (const item of shapes) for (const type of ['item.started', 'item.updated', 'item.completed']) {
    const { out } = run(ev(type, item));
    assert.ok(out.length >= 1, `${JSON.stringify(item)} ${type}`);
  }
});

test('the tool name may sit under another key', () => {
  const { out } = run(ev('item.started', { id: 'k1', type: 'collab_tool_call', tool_name: 'spawn_agent', prompt: 'Do it' }));
  assert.equal(out[0].subagent?.action, 'spawn');
});

test('an id-less fallback item keeps one stable id across its updates, so updates merge instead of piling up', () => {
  const map = new Map();
  const item = { type: 'agent_thread', tool: 'mystery', prompt: 'same prompt' };
  for (const type of ['item.started', 'item.updated', 'item.completed']) for (const a of run(ev(type, { ...item, status: type === 'item.completed' ? 'completed' : 'in_progress' })).out) applyActivity(map, a);
  assert.equal(map.size, 1);
  assert.equal([...map.values()][0].status, 'success');
});

test('items that are not subagent-like keep their old behaviour and are not reported', () => {
  const { out, unmapped } = run(ev('item.completed', { id: 'cmd', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'a' }));
  assert.equal(out[0].status, 'success');
  assert.equal(out[0].output, 'a');
  assert.deepEqual(unmapped, []);
  assert.deepEqual(run(ev('item.completed', { type: 'agent_message', text: 'hi' })).out, []);
  assert.deepEqual(run(ev('item.completed', { type: 'reasoning', text: 'hmm' })).out, []);
});

test('a throwing report callback does not lose the card', () => {
  const out = nativeActivities('codex', ev('item.started', { id: 'z', type: 'collab_tool_call', tool: 'nope' }), () => { throw new Error('log failed'); });
  assert.equal(out.length, 1);
});

// ---- the raw log ----

test('a log line is JSON with time, provider and chat; JSON events are scrubbed, non-JSON lines are kept as text', () => {
  const t = Date.UTC(2026, 9, 3, 12, 0, 0);
  const line = JSON.parse(rawLogLine({ t, provider: 'codex', chat: 7, line: JSON.stringify({ type: 'item.started', item: { command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123"', api_key: 'hunter2hunter2' } }) }));
  assert.equal(line.t, '2026-10-03T12:00:00.000Z');
  assert.equal(line.provider, 'codex');
  assert.equal(line.chat, 7);
  assert.equal(line.event.type, 'item.started');
  assert.doesNotMatch(JSON.stringify(line), /abcdefghijklmnopqrstuvwxyz0123|hunter2/);
  const banner = JSON.parse(rawLogLine({ t, provider: 'claude', chat: null, line: 'WARN sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 expired' }));
  assert.equal(banner.chat, null);
  assert.match(banner.text, /WARN .*REDACTED.* expired/);
  assert.doesNotMatch(banner.text, /sk-ant-api03/);
});

test('an oversized entry is clipped to one bounded line', () => {
  const huge = JSON.stringify({ type: 'x', data: 'a'.repeat(MAX_ENTRY_CHARS * 2) });
  const out = rawLogLine({ t: 0, provider: 'codex', chat: 1, line: huge });
  assert.ok(out.length < MAX_ENTRY_CHARS + 400);
  assert.ok(JSON.parse(out).truncated > MAX_ENTRY_CHARS);
});

test('a disabled logger writes nothing; an enabled one batches per day, adds the unmapped total and never throws', async () => {
  const writes = [];
  const off = createRawLogger(false, 'codex', 1, async (d, l) => { writes.push([d, l]); });
  off.raw('{"a":1}'); off.unmapped({ x: 1 }); await off.flush();
  assert.deepEqual(writes, []);

  const now = Date.UTC(2026, 9, 3, 12, 0, 0);
  const log = createRawLogger(true, 'codex', 4, async (d, l) => { writes.push([d, l]); }, () => now);
  log.raw('{"type":"thread.started"}');
  log.raw('not json');
  log.unmapped({ type: 'collab_tool_call', tool: 'zzz' });
  log.unmapped({ type: 'collab_tool_call', tool: 'yyy' });
  await log.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], dayOf(now));
  const lines = writes[0][1].trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event?.type ?? l.text ?? l.debug), ['thread.started', 'not json', 'unmapped-collab-item', 'unmapped-collab-item', 'unmapped-total']);
  assert.equal(lines.at(-1).data.count, 2);

  const broken = createRawLogger(true, 'claude', 1, async () => { throw new Error('disk full'); });
  broken.raw('{"a":1}');
  await broken.flush();
});

test('raw CLI capture is off: an old saved recordRawCliEvents flag is ignored', async () => {
  await setSetting('recordRawCliEvents', true);
  assert.equal(await rawLogEnabled(), false);
});
