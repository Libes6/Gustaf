// The live-run store that makes a scheduled run visible in its chat (src/lib/liveRuns.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const live = await import('../src/lib/liveRuns.ts');

const act = (id, status = 'running') => ({ type: 'activity', id, name: 'run_command', args: {}, status });

test('a live run exposes streamed text, activities, tool results and the retry notice, with a new object per change', () => {
  let aborted = 0;
  const h = live.beginLiveRun(11, 'Nightly', () => void aborted++);
  const first = live.getLiveRun(11);
  assert.equal(first.stream, '');
  assert.equal(first.title, 'Nightly');
  assert.deepEqual([...live.getLiveChats()], [11]);
  h.text('Hel');
  h.text('lo');
  const after = live.getLiveRun(11);
  assert.notEqual(after, first, 'a new snapshot for useSyncExternalStore');
  assert.equal(after.stream, 'Hello');
  assert.equal(after.stats.chars, 5);
  h.activities([act('a1')]);
  h.toolResult({ type: 'tool_result', id: 'a1', name: 'x', output: 'o' });
  h.toolResult({ type: 'tool_result', id: 'a1', name: 'x', output: 'o2' });
  h.retry('retrying in 3 s');
  const s = live.getLiveRun(11);
  assert.equal(s.activities.length, 1);
  assert.deepEqual(
    s.toolResults.map((r) => r.output),
    ['o2'],
    'a result replaces the earlier one with the same id',
  );
  assert.equal(s.retryNotice, 'retrying in 3 s');
  h.text('x');
  assert.equal(live.getLiveRun(11).retryNotice, '', 'output clears the notice');
  live.getLiveRun(11).abort();
  assert.equal(aborted, 1, 'Stop in the chat reaches the run');
  h.end();
});

test('a stored message resets the step and bumps the version so open chats reload; ending removes the run', () => {
  const seen = [];
  const off = live.subscribeLiveRuns(() => seen.push(live.liveVersion(12)));
  const v0 = live.liveVersion(12);
  const h = live.beginLiveRun(12, 'T', () => {});
  h.text('partial');
  h.activities([act('a')]);
  const v1 = live.liveVersion(12);
  h.message('assistant');
  const s = live.getLiveRun(12);
  assert.equal(s.stream, '');
  assert.deepEqual(s.activities, []);
  assert.ok(live.liveVersion(12) > v1);
  h.toolResult({ type: 'tool_result', id: 'r', name: 'x', output: 'o' });
  h.message('assistant');
  assert.equal(live.getLiveRun(12).toolResults.length, 1, 'tool results stay until the tool message is stored');
  h.message('tool');
  assert.equal(live.getLiveRun(12).toolResults.length, 0);
  const v2 = live.liveVersion(12);
  h.end();
  assert.equal(live.getLiveRun(12), undefined);
  assert.deepEqual([...live.getLiveChats()], []);
  assert.ok(live.liveVersion(12) > v2, 'the chat reloads once more when the run ends');
  assert.ok(live.liveVersion(12) > v0);
  assert.ok(seen.length > 0);
  off();
  h.text('late');
  h.message();
  h.end();
  assert.equal(live.getLiveRun(12), undefined, 'calls after the end are ignored');
});

test('an approval is shown in the chat until answered or withdrawn', () => {
  const h = live.beginLiveRun(13, 'T', () => {});
  const answers = [];
  const withdraw = h.approval({ kind: 'command', command: 'npm publish' }, (ok) => answers.push(ok));
  const a = live.getLiveRun(13).approval;
  assert.equal(a.req.command, 'npm publish');
  a.resolve(true);
  assert.deepEqual(answers, [true]);
  withdraw();
  assert.equal(live.getLiveRun(13).approval, null);
  h.end();
});

test('two runs in one chat: the chat stays live until both are over', () => {
  const a = live.beginLiveRun(14, 'A', () => {});
  const b = live.beginLiveRun(14, 'B', () => {});
  assert.equal(live.getLiveRun(14).title, 'B');
  b.text('x');
  b.end();
  assert.equal(live.getLiveRun(14).title, 'A');
  a.end();
  assert.equal(live.getLiveRun(14), undefined);
  assert.equal(live.getLiveRun(null), undefined);
  assert.equal(live.liveVersion(null), 0);
});
