import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  editableText,
  messageImages,
  messagesBefore,
  turnMessageIds,
  branchCutoff,
  branchSlice,
  branchTitle,
  turnActions,
  MAX_TITLE,
} from '../src/lib/messageActions.ts';

const txt = (id, role, text, meta) => ({ id, role, parts: [{ type: 'text', text }], meta });
const calls = (id) => ({ id, role: 'assistant', parts: [{ type: 'tool_call', id: `c${id}`, name: 'x', args: {} }] });
const result = (id) => ({ id, role: 'tool', parts: [{ type: 'tool_result', id: `c${id - 1}`, output: 'ok' }] });

test('editableText drops the appended file blocks only', () => {
  assert.equal(editableText(txt(1, 'user', 'hello @a.ts\n\n<file path="a.ts">\nx\n</file>')), 'hello @a.ts');
  assert.equal(editableText(txt(1, 'user', 'plain')), 'plain');
  assert.equal(editableText({ id: 1, role: 'user', parts: [{ type: 'image', data: 'AA' }] }), '');
});

test('messageImages returns image data in order', () => {
  const m = {
    id: 1,
    role: 'user',
    parts: [
      { type: 'text', text: 'a' },
      { type: 'image', data: 'AA' },
      { type: 'image', data: 'BB' },
    ],
  };
  assert.deepEqual(messageImages(m), ['AA', 'BB']);
});

test('messagesBefore excludes the cut message and everything after', () => {
  const ms = [txt(1, 'user', 'a'), txt(2, 'assistant', 'b'), txt(3, 'user', 'c')];
  assert.deepEqual(
    messagesBefore(ms, 3).map((m) => m.id),
    [1, 2],
  );
  assert.deepEqual(messagesBefore(ms, 1), []);
});

test('turnMessageIds covers user and steps', () => {
  assert.deepEqual(
    turnMessageIds({ user: txt(1, 'user', 'a'), steps: [calls(2), result(3), txt(4, 'assistant', 'z')] }),
    [1, 2, 3, 4],
  );
  assert.deepEqual(turnMessageIds({ steps: [txt(5, 'assistant', 'z')] }), [5]);
});

test('branchCutoff includes the message itself', () => {
  const ms = [txt(1, 'user', 'a'), txt(2, 'assistant', 'b'), txt(3, 'user', 'c'), txt(4, 'assistant', 'd')];
  assert.equal(branchCutoff(ms, 1), 1);
  assert.equal(branchCutoff(ms, 2), 2);
  assert.equal(branchCutoff(ms, 4), 4);
  assert.equal(branchCutoff(ms, 99), null);
});

test('branchCutoff keeps the tool results that answer an assistant tool call', () => {
  const ms = [txt(1, 'user', 'a'), calls(2), result(3), calls(4), result(5), txt(6, 'assistant', 'done')];
  assert.equal(branchCutoff(ms, 2), 3);
  assert.equal(branchCutoff(ms, 4), 5);
  assert.equal(branchCutoff(ms, 6), 6);
});

test('branchSlice returns the history up to the cutoff and is empty for an unknown id', () => {
  const ms = [txt(10, 'user', 'a'), txt(20, 'assistant', 'b'), txt(30, 'user', 'c')];
  assert.deepEqual(
    branchSlice(ms, 20).map((m) => m.id),
    [10, 20],
  );
  assert.deepEqual(branchSlice(ms, 7), []);
});

test('branchTitle appends the label and counts up instead of stacking', () => {
  assert.equal(branchTitle('Fix login', 'branch'), 'Fix login (branch)');
  assert.equal(branchTitle('Fix login (branch)', 'branch'), 'Fix login (branch 2)');
  assert.equal(branchTitle('Fix login (branch 2)', 'branch'), 'Fix login (branch 3)');
  assert.equal(branchTitle('Починить вход', 'ветка'), 'Починить вход (ветка)');
  assert.equal(branchTitle('Починить вход (ветка)', 'ветка'), 'Починить вход (ветка 2)');
  assert.equal(branchTitle('A (branch) and more', 'branch'), 'A (branch) and more (branch)');
  assert.equal(branchTitle('', 'branch'), ' (branch)');
});

test('branchTitle shortens a long base but keeps the suffix', () => {
  const out = branchTitle('x'.repeat(500), 'branch');
  assert.ok(out.length <= MAX_TITLE);
  assert.ok(out.endsWith('… (branch)'));
  const again = branchTitle(out, 'branch');
  assert.ok(again.length <= MAX_TITLE);
  assert.ok(again.endsWith(' (branch 2)'));
});

test('branchTitle treats regex characters in the label literally', () => {
  assert.equal(branchTitle('T (a.b)', 'a.b'), 'T (a.b 2)');
  assert.equal(branchTitle('T (axb)', 'a.b'), 'T (axb) (a.b)');
});

const turn = (steps, user = txt(1, 'user', 'q')) => ({ user, steps });

test('turnActions: regenerate only for the last turn that ends with assistant text', () => {
  const done = turn([txt(2, 'assistant', 'a')]);
  assert.equal(turnActions(done, { busy: false, isLastTurn: true }).show.regenerate, true);
  assert.equal(turnActions(done, { busy: false, isLastTurn: false }).show.regenerate, false);
  assert.equal(turnActions(turn([calls(2), result(3)]), { busy: false, isLastTurn: true }).show.regenerate, false);
  assert.equal(
    turnActions({ steps: [txt(2, 'assistant', 'a')] }, { busy: false, isLastTurn: true }).show.regenerate,
    false,
  );
});

test('turnActions: every action is disabled while a run is active', () => {
  const a = turnActions(turn([txt(2, 'assistant', 'a')]), { busy: true, isLastTurn: true });
  assert.deepEqual(a.show, { edit: true, regenerate: true, remove: true, branch: true });
  assert.deepEqual(a.enabled, { edit: false, regenerate: false, remove: false, branch: false });
  const idle = turnActions(turn([txt(2, 'assistant', 'a')]), { busy: false, isLastTurn: true });
  assert.deepEqual(idle.enabled, idle.show);
});

test('turnActions: compacted summaries offer no edit, regenerate, delete or branch', () => {
  const a = turnActions(turn([txt(2, 'assistant', 'a')], txt(1, 'user', 's', { compacted: true })), {
    busy: false,
    isLastTurn: true,
  });
  assert.deepEqual(a.show, { edit: false, regenerate: false, remove: false, branch: false });
});

test('editableText keeps pasted texts and chat references that follow the file blocks', () => {
  const paste =
    '\n\n<gustaf-pasted-text>\nText the user pasted into the message:\n{"text":"log"}\n</gustaf-pasted-text>';
  assert.equal(
    editableText(txt(1, 'user', 'see @a.ts\n\n<file path="a.ts">\nx\n</file>' + paste)),
    'see @a.ts' + paste,
  );
  assert.equal(editableText(txt(1, 'user', 'plain' + paste)), 'plain' + paste);
});
