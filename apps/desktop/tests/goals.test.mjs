import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterTurn, continuePrompt, goalPrompt, goalReport, isContinuation, newGoal, parseGoalCommand, resumeGoal } from '../src/lib/goalCore.ts';

test('parseGoalCommand reads the objective after /goal', () => {
  assert.equal(parseGoalCommand('/goal make the tests pass'), 'make the tests pass');
  assert.equal(parseGoalCommand('  /goal  multi\nline  '), 'multi\nline');
  assert.equal(parseGoalCommand('/goal'), null);
  assert.equal(parseGoalCommand('/goals x'), null);
  assert.equal(parseGoalCommand('please /goal x'), null);
});

test('goalReport takes the last GOAL line', () => {
  assert.deepEqual(goalReport('did it\nGOAL: done\nAll green.'), { kind: 'done', note: '' });
  assert.deepEqual(goalReport('**GOAL:** blocked - need the API key'), { kind: 'blocked', note: 'need the API key' });
  assert.deepEqual(goalReport('GOAL: blocked - x\nlater\nGOAL: done'), { kind: 'done', note: '' });
  assert.equal(goalReport('the goal is not done yet'), null);
});

const g = (over = {}) => ({ ...newGoal('ship it', 1, 3), ...over });

test('afterTurn continues an active goal and counts turns and tokens', () => {
  const r = afterTurn(g(), { outcome: 'ok', lastText: 'step 1 done', tokens: 120 });
  assert.equal(r.goal.turns, 1);
  assert.equal(r.goal.tokens, 120);
  assert.equal(r.goal.status, 'active');
  assert.equal(r.continueWith, continuePrompt(r.goal));
  assert.ok(isContinuation(r.continueWith));
});

test('afterTurn stops on done, blocked, Stop, failure and the turn limit', () => {
  assert.equal(afterTurn(g(), { outcome: 'ok', lastText: 'GOAL: done', tokens: 0 }).goal.status, 'done');
  const blocked = afterTurn(g(), { outcome: 'ok', lastText: 'GOAL: blocked - which branch?', tokens: 0 });
  assert.deepEqual([blocked.goal.status, blocked.goal.note, blocked.continueWith], ['blocked', 'which branch?', null]);
  assert.deepEqual([afterTurn(g(), { outcome: 'stopped', lastText: '', tokens: 0 }).goal.status, afterTurn(g(), { outcome: 'stopped', lastText: '', tokens: 0 }).goal.note], ['paused', 'stopped']);
  assert.equal(afterTurn(g(), { outcome: 'failed', lastText: '', tokens: 0 }).continueWith, null);
  const last = afterTurn(g({ turns: 2 }), { outcome: 'ok', lastText: 'more', tokens: 0 });
  assert.deepEqual([last.goal.status, last.goal.note, last.continueWith], ['paused', 'limit', null]);
});

test('a goal paused during its turn never continues', () => {
  const r = afterTurn(g({ status: 'paused' }), { outcome: 'ok', lastText: 'step', tokens: 5 });
  assert.equal(r.continueWith, null);
  assert.equal(r.goal.turns, 1);
});

test('resumeGoal reactivates with room for more turns', () => {
  const r = resumeGoal(g({ status: 'paused', note: 'limit', turns: 3 }));
  assert.deepEqual([r.status, r.note, r.maxTurns], ['active', undefined, 8]);
  assert.match(goalPrompt('x'), /GOAL: done/);
});

import { fromNativeStatus, newNativeGoal } from '../src/lib/goalCore.ts';
test('native goal statuses map to ours; limits are resumable pauses', () => {
  assert.deepEqual(fromNativeStatus('complete'), { status: 'done' });
  assert.deepEqual(fromNativeStatus('blocked'), { status: 'blocked' });
  assert.deepEqual(fromNativeStatus('usageLimited'), { status: 'paused', note: 'usage' });
  assert.deepEqual(fromNativeStatus('budgetLimited'), { status: 'paused', note: 'budget' });
  assert.deepEqual(fromNativeStatus('active'), { status: 'active' });
  assert.equal(newNativeGoal('x', 1).native, true);
});
