// CLI-native subagents mirrored in the agents panel (src/agent/cliAgents.ts), fed by the run core.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
await import('./helpers/apiStub.mjs');
const { trackCliAgents, finishCliAgents, clearFinishedCliAgents, getCliAgents, resetCliAgents, cliAgentFrom } = await import('../src/agent/cliAgents.ts');
const { runChatCore } = await import('../src/lib/chatRunCore.ts');

const act = (id, state, over = {}) => ({ type: 'activity', id, name: 'subagent', args: {}, status: state === 'completed' ? 'success' : state === 'failed' ? 'error' : 'running', subagent: { provider: 'codex', agentId: `t-${id}`, title: `Agent ${id}`, action: 'wait', state, ...over } });

beforeEach(() => resetCliAgents());

test('entries follow the activity stream, keep their start time and are listed per chat and project', () => {
  trackCliAgents({ chatId: 1, root: '/p' }, [act('a', 'running')], 100);
  trackCliAgents({ chatId: 1, root: '/p' }, [act('a', 'completed', { result: 'ok' })], 200);
  trackCliAgents({ chatId: 2, root: '/q' }, [act('b', 'running')], 300);
  const all = getCliAgents();
  assert.equal(all.length, 2);
  const a = all.find((e) => e.key === '1:a');
  assert.equal(a.state, 'completed');
  assert.equal(a.result, 'ok');
  assert.equal(a.startedAt, 100);
  assert.equal(a.endedAt, 200);
  assert.equal(all.find((e) => e.key === '2:b').root, '/q');
});

test('an update that changes nothing does not replace the list; activities without subagent info and runs without a project are ignored', () => {
  trackCliAgents({ chatId: 1, root: '/p' }, [act('a', 'running')], 100);
  const before = getCliAgents();
  trackCliAgents({ chatId: 1, root: '/p' }, [act('a', 'running')], 999);
  assert.equal(getCliAgents(), before);
  trackCliAgents({ chatId: 1, root: '/p' }, [{ type: 'activity', id: 'x', name: 'Read', args: {}, status: 'running' }]);
  trackCliAgents({ chatId: 3, root: null }, [act('z', 'running')]);
  assert.equal(getCliAgents().length, 1);
  assert.equal(cliAgentFrom({ type: 'activity', id: 'x', name: 'Read', args: {}, status: 'running' }, { chatId: 1, root: '/p' }, undefined, 0), null);
});

test('finishing a run marks running agents ended, drops their stop handle and clearing removes only finished ones', () => {
  const stop = () => {};
  trackCliAgents({ chatId: 1, root: '/p', stop }, [act('a', 'running'), act('b', 'completed')], 100);
  assert.equal(getCliAgents().find((e) => e.key === '1:a').stop, stop);
  finishCliAgents(1, 500);
  const [a, b] = ['1:a', '1:b'].map((k) => getCliAgents().find((e) => e.key === k));
  assert.equal(a.state, 'unknown');
  assert.equal(a.endedAt, 500);
  assert.equal(a.stop, undefined);
  assert.equal(b.state, 'completed');
  trackCliAgents({ chatId: 2, root: '/p' }, [act('c', 'running')]);
  clearFinishedCliAgents('/p');
  assert.deepEqual(getCliAgents().map((e) => e.key), ['2:c']);
});

test('agents still running when the user stopped the chat run are "stopped", not "unknown"', () => {
  trackCliAgents({ chatId: 3, root: '/p', stop: () => {} }, [act('s', 'running'), act('t', 'completed')], 100);
  finishCliAgents(3, 600, true);
  const [s, t] = ['3:s', '3:t'].map((k) => getCliAgents().find((e) => e.key === k));
  assert.equal(s.state, 'stopped');
  assert.equal(s.endedAt, 600);
  assert.equal(s.stop, undefined);
  assert.equal(t.state, 'completed');
});

test('runChatCore feeds the store while the run is live and finishes it afterwards (also when the run fails)', async () => {
  const seenLive = [];
  const deps = {
    addMessage: async () => 1,
    recordUsage() {}, bumpUsage() {}, recordResult() {},
    runAgent: async (o) => {
      o.onActivity(act('a', 'running'));
      o.onActivity(act('b', 'running'));
      o.onActivity(act('a', 'completed'));
      seenLive.push(getCliAgents().map((e) => [e.key, e.state]));
      if (o.history.length > 5) throw new Error('boom');
    },
  };
  const stop = () => {};
  const input = (history) => ({ chatId: 9, root: '/proj', history, access: 'readonly', allowlist: [], signal: new AbortController().signal, stop, approve: async () => ({ ok: true }), target: async () => ({ adapter: {}, providerId: 'codex', model: 'm', supportsTools: true, computerUse: false }) });
  const ui = { onActivity: (list) => seenLive.push(list.map((p) => p.id)) };
  await runChatCore(input([{ role: 'user', parts: [{ type: 'text', text: 'go' }] }]), deps, ui);
  // The card order stays a, b even though a was updated last.
  assert.deepEqual(seenLive.filter((x) => typeof x[0] === 'string').pop(), ['a', 'b']);
  assert.deepEqual(seenLive.find((x) => Array.isArray(x[0]))?.sort(), [['9:a', 'completed'], ['9:b', 'running']]);
  const after = Object.fromEntries(getCliAgents().map((e) => [e.key, e.state]));
  assert.deepEqual(after, { '9:a': 'completed', '9:b': 'unknown' });
  resetCliAgents();
  const long = Array.from({ length: 6 }, () => ({ role: 'user', parts: [{ type: 'text', text: 'x' }] }));
  await assert.rejects(runChatCore(input(long), deps, ui), /boom/);
  assert.equal(getCliAgents().find((e) => e.key === '9:b').state, 'unknown');
});

test('a provider-reported "unknown" agent is not active, has an end time and can still be replaced by a real report', () => {
  trackCliAgents({ chatId: 4, root: '/p' }, [act('u', 'running')], 100);
  trackCliAgents({ chatId: 4, root: '/p' }, [act('u', 'unknown')], 200);
  const u = () => getCliAgents().find((e) => e.key === '4:u');
  assert.equal(u().state, 'unknown');
  assert.equal(u().endedAt, 200);
  trackCliAgents({ chatId: 4, root: '/p' }, [act('u', 'completed')], 300);
  assert.equal(u().state, 'completed');
});

// Background shell commands (Claude Code `Bash` with `run_in_background`): they used to be dropped because only
// activities with `subagent` info were tracked, so the panel never listed them.
const shellCall = (over = {}) => ({ type: 'activity', id: 'tu7', name: 'Bash', args: { command: 'npm run tauri -- build', description: 'Release build', run_in_background: true }, status: 'running', ...over });
const launched = () => shellCall({ status: 'success', output: 'Command running in background with ID: bx9y8z. Output is being written to: /tmp/bx9y8z.output' });
const shellNotice = (state) => ({ type: 'activity', id: 'bg:bx9y8z', name: '', args: {}, status: state === 'completed' ? 'success' : 'error', output: 'Build finished', subagent: { provider: 'claude', agentId: 'bx9y8z', bgId: 'bx9y8z', title: '', action: 'close', state, result: 'Build finished' } });

test('a background Bash command becomes a running command task with its shell id, tracked from its start', () => {
  trackCliAgents({ chatId: 1, root: '/p' }, [shellCall()], 100);
  assert.equal(getCliAgents().length, 1);
  trackCliAgents({ chatId: 1, root: '/p' }, [launched()], 150);
  const [c] = getCliAgents();
  assert.equal(c.command, 'npm run tauri -- build');
  assert.equal(c.title, 'Release build');
  assert.equal(c.state, 'running');
  assert.equal(c.shellId, 'bx9y8z');
  assert.equal(c.startedAt, 100);
});

test('foreground Bash calls are not background tasks', () => {
  trackCliAgents({ chatId: 1, root: '/p' }, [shellCall({ args: { command: 'ls' } })], 100);
  assert.equal(getCliAgents().length, 0);
});

test('the completion notice closes the command (not a phantom agent); failure is kept', () => {
  trackCliAgents({ chatId: 1, root: '/p' }, [launched()], 100);
  trackCliAgents({ chatId: 1, root: '/p' }, [launched(), shellNotice('completed')], 900);
  const all = getCliAgents();
  assert.equal(all.length, 1);
  assert.equal(all[0].state, 'completed');
  assert.equal(all[0].endedAt, 900);
  assert.equal(all[0].output, 'Build finished');
  resetCliAgents();
  trackCliAgents({ chatId: 1, root: '/p' }, [launched(), shellNotice('failed')], 100);
  assert.equal(getCliAgents()[0].state, 'failed');
});

test('a command still running when the run ends ends as unknown (no result was reported); stopping the run marks it stopped', () => {
  const stop = () => {};
  trackCliAgents({ chatId: 1, root: '/p', stop }, [launched()], 100);
  assert.equal(getCliAgents()[0].stop, stop);
  finishCliAgents(1, 500);
  assert.equal(getCliAgents()[0].state, 'unknown');
  assert.equal(getCliAgents()[0].stop, undefined);
  resetCliAgents();
  trackCliAgents({ chatId: 1, root: '/p' }, [launched()], 100);
  finishCliAgents(1, 500, true);
  assert.equal(getCliAgents()[0].state, 'stopped');
});

test('a background command that failed to start is failed at once', () => {
  trackCliAgents({ chatId: 1, root: '/p' }, [shellCall({ status: 'error', output: 'permission denied' })], 100);
  assert.equal(getCliAgents()[0].state, 'failed');
});

test('runChatCore feeds background Bash activities into the store', async () => {
  let live;
  const deps = { addMessage: async () => 1, recordUsage() {}, bumpUsage() {}, recordResult() {}, runAgent: async (o) => { o.onActivity(shellCall()); o.onActivity(launched()); live = getCliAgents().map((e) => e.state); } };
  const input = { chatId: 8, root: '/proj', history: [{ role: 'user', parts: [{ type: 'text', text: 'go' }] }], access: 'readonly', allowlist: [], signal: new AbortController().signal, approve: async () => ({ ok: true }), target: async () => ({ adapter: {}, providerId: 'claude-code', model: 'm', supportsTools: true, computerUse: false }) };
  await runChatCore(input, deps, {});
  assert.deepEqual(live, ['running']);
  assert.equal(getCliAgents()[0].state, 'unknown');
});
