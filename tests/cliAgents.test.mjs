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
  assert.equal(a.state, 'ended');
  assert.equal(a.endedAt, 500);
  assert.equal(a.stop, undefined);
  assert.equal(b.state, 'completed');
  trackCliAgents({ chatId: 2, root: '/p' }, [act('c', 'running')]);
  clearFinishedCliAgents('/p');
  assert.deepEqual(getCliAgents().map((e) => e.key), ['2:c']);
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
  assert.deepEqual(after, { '9:a': 'completed', '9:b': 'ended' });
  resetCliAgents();
  const long = Array.from({ length: 6 }, () => ({ role: 'user', parts: [{ type: 'text', text: 'x' }] }));
  await assert.rejects(runChatCore(input(long), deps, ui), /boom/);
  assert.equal(getCliAgents().find((e) => e.key === '9:b').state, 'ended');
});
