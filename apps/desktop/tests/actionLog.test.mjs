import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ENTRIES,
  actionKind,
  appendEntry,
  clipDetail,
  isEditTool,
  mergeLogs,
  normalizeActionLog,
  patchEntry,
  summarizeCall,
  undoBlocker,
} from '../src/agent/actionLog.ts';

const B1 = 'a'.repeat(40);
const B2 = 'b'.repeat(40);
const entry = (id, over = {}) => ({
  id,
  at: Number(id.replace(/\D/g, '')) || 1,
  tool: 'run_command',
  summary: 'ls',
  status: 'success',
  ...over,
});
const edit = (id, path, over = {}) =>
  entry(id, { tool: 'edit_file', summary: path, undo: { root: '/ws', path, before: B1, after: B2 }, ...over });

test('calls are summarised on one line without secrets', () => {
  assert.equal(summarizeCall('run_command', { command: 'npm test' }), 'npm test');
  assert.equal(
    summarizeCall(
      'gustaf_computer',
      {},
      {
        actions: [
          { type: 'open_app', name: 'Telegram' },
          { type: 'click', x: 1, y: 2 },
        ],
      },
    ),
    'open_app "Telegram" · click 1,2',
  );
  assert.equal(summarizeCall('run_command', { command: 'echo a\n  echo b' }), 'echo a ⏎ echo b');
  assert.equal(summarizeCall('read_file', { path: 'src/a.ts', offset: 1 }), 'src/a.ts');
  assert.equal(
    summarizeCall('edit_file', { path: 'src/a.ts', old_string: 'SECRET_BODY', new_string: 'x' }),
    'src/a.ts',
    'file contents are not logged',
  );
  assert.equal(summarizeCall('write_file', { path: 'a.txt', content: 'x'.repeat(5000) }), 'a.txt');
  assert.equal(summarizeCall('list_dir', { path: 'src' }), 'src');
  assert.equal(summarizeCall('list_dir', {}), '.');
  assert.equal(summarizeCall('search', { pattern: 'TODO', glob: '*.ts' }), 'TODO · *.ts');
  assert.equal(summarizeCall('search', { pattern: 'TODO' }), 'TODO');
  assert.equal(
    summarizeCall(
      'computer',
      {},
      {
        actions: [
          { type: 'click', x: 3, y: 4 },
          { type: 'type', text: 'hello' },
          { type: 'keypress', keys: ['cmd', 'c'] },
          { type: 'screenshot' },
        ],
      },
    ),
    'click 3,4 · type "hello" · cmd+c · screenshot',
  );
  assert.equal(summarizeCall('mystery', { a: 1 }), '{"a":1}');
  assert.equal(summarizeCall('mystery', null), '');
  assert.equal(summarizeCall('run_command', undefined), '');
  assert.equal(summarizeCall('run_command', { command: 5 }), '');
  assert.ok(summarizeCall('run_command', { command: 'x'.repeat(5000) }).length <= 300);
  const secret = summarizeCall('run_command', {
    command: 'curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" https://x',
  });
  assert.doesNotMatch(secret, /sk-abcdef/);
  assert.match(secret, /REDACTED/);
  assert.doesNotMatch(summarizeCall('run_command', { command: 'API_KEY=hunter2hunter2 npm run dev' }), /hunter2/);
});

test('kinds of calls', () => {
  assert.equal(actionKind('run_command'), 'command');
  assert.equal(actionKind('edit_file'), 'edit');
  assert.equal(actionKind('write_file'), 'edit');
  assert.equal(actionKind('read_file'), 'read');
  assert.equal(actionKind('list_dir'), 'read');
  assert.equal(actionKind('search'), 'read');
  assert.equal(actionKind('computer'), 'computer');
  assert.equal(actionKind('anything'), 'other');
  assert.equal(isEditTool('edit_file') && isEditTool('write_file') && !isEditTool('read_file'), true);
});

test('a stored log is validated; runs that never finished become "interrupted"', () => {
  assert.deepEqual(normalizeActionLog(undefined), []);
  assert.deepEqual(normalizeActionLog('x'), []);
  assert.deepEqual(normalizeActionLog({}), []);
  assert.deepEqual(normalizeActionLog([null, 1, 'x', [], {}, { id: 'a' }]), []);
  const raw = [
    entry('1'),
    entry('2', { status: 'running' }),
    entry('3', { status: 'weird' }),
    entry('1', { summary: 'duplicate id' }),
    entry('4', { at: 'soon' }),
    entry('5', { at: Infinity }),
    entry('6', { tool: 5 }),
    entry('7', {
      approval: 'rule',
      rule: 'allow prefix: ls',
      builtin: true,
      durationMs: 12,
      detail: 'oops',
      project: '/p',
      root: '/ws',
      extra: 'dropped',
    }),
    entry('8', { approval: 'magic', rule: '', durationMs: 'long', builtin: 'yes' }),
    entry('9', { summary: undefined }),
  ];
  const out = normalizeActionLog(raw);
  assert.deepEqual(
    out.map((e) => e.id),
    ['1', '2', '7', '8', '9'],
  );
  assert.equal(out[1].status, 'interrupted');
  assert.deepEqual(out[2], {
    id: '7',
    at: 7,
    tool: 'run_command',
    summary: 'ls',
    status: 'success',
    durationMs: 12,
    root: '/ws',
    project: '/p',
    approval: 'rule',
    rule: 'allow prefix: ls',
    builtin: true,
    detail: 'oops',
  });
  assert.deepEqual(out[3], { id: '8', at: 8, tool: 'run_command', summary: 'ls', status: 'success' });
  assert.equal(out[4].summary, '');
  assert.deepEqual(normalizeActionLog(JSON.parse(JSON.stringify(out))), out, 'idempotent');
});

test('stored undo records are validated, so a corrupt file cannot smuggle options into git', () => {
  const good = { root: '/ws', path: 'a.txt', before: B1, after: B2, reviewId: '1-2', undone: 5 };
  assert.deepEqual(normalizeActionLog([entry('1', { undo: good })])[0].undo, good);
  assert.deepEqual(normalizeActionLog([entry('1', { undo: { ...good, before: null } })])[0].undo.before, null);
  for (const bad of [
    { ...good, before: '--output=x' },
    { ...good, before: 'nope' },
    { ...good, after: null },
    { ...good, after: '--foo' },
    { ...good, root: 5 },
    { ...good, path: null },
    'x',
    5,
    [],
  ]) {
    assert.equal(normalizeActionLog([entry('1', { undo: bad })])[0].undo, undefined, JSON.stringify(bad));
  }
  const odd = normalizeActionLog([entry('1', { undo: { ...good, reviewId: '../x', undone: 'yes' } })])[0].undo;
  assert.equal(odd.reviewId, undefined);
  assert.equal(odd.undone, undefined);
});

test('the log is bounded and keeps the newest entries', () => {
  let list = [];
  for (let i = 0; i < MAX_ENTRIES + 25; i++) list = appendEntry(list, entry(`e${i}`));
  assert.equal(list.length, MAX_ENTRIES);
  assert.equal(list[0].id, 'e25');
  assert.equal(list.at(-1).id, `e${MAX_ENTRIES + 24}`);
  const big = normalizeActionLog(Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => entry(`x${i}`)));
  assert.equal(big.length, MAX_ENTRIES);
  assert.equal(big.at(-1).id, `x${MAX_ENTRIES + 9}`);
  assert.equal(appendEntry([], entry('a')).length, 1);
  const before = [entry('a')];
  appendEntry(before, entry('b'));
  assert.equal(before.length, 1, 'does not mutate');
});

test('entries are patched by id and logs merge without duplicates', () => {
  const list = [entry('a'), entry('b')];
  const patched = patchEntry(list, 'b', { status: 'error', detail: 'x' });
  assert.deepEqual(patched[1], { ...entry('b'), status: 'error', detail: 'x' });
  assert.equal(patched[0], list[0]);
  assert.deepEqual(patchEntry(list, 'zzz', { status: 'error' }), list);
  assert.equal(list[1].status, 'success');
  const merged = mergeLogs([entry('a'), entry('b')], [entry('b', { status: 'error' }), entry('c')]);
  assert.deepEqual(
    merged.map((e) => [e.id, e.status]),
    [
      ['a', 'success'],
      ['b', 'error'],
      ['c', 'success'],
    ],
  );
  assert.deepEqual(mergeLogs([], []), []);
});

test('detail text is one short scrubbed line', () => {
  assert.equal(clipDetail('exit code: 1\nboom'), 'exit code: 1 ⏎ boom');
  assert.ok(clipDetail('x'.repeat(1000)).length <= 240);
  assert.doesNotMatch(clipDetail('token=abcdefghijklmnopqrstuvwxyz123456'), /abcdefghijkl/);
  assert.equal(clipDetail('  padded  '), 'padded');
});

test('undo is offered only for the newest live edit of a file, when its folder is idle', () => {
  const none = new Set();
  const e1 = edit('1', 'a.txt');
  const e2 = edit('2', 'a.txt');
  const e3 = edit('3', 'b.txt');
  const log = [e1, e2, e3, entry('4')];
  assert.equal(undoBlocker(log, e3, none), null);
  assert.equal(undoBlocker(log, e2, none), null);
  assert.equal(undoBlocker(log, e1, none), 'later', 'a newer edit of the same file comes first');
  assert.equal(undoBlocker(log, log[3], none), 'none', 'commands have no undo');
  assert.equal(undoBlocker(log, e2, new Set(['/ws'])), 'running');
  assert.equal(undoBlocker(log, e2, new Set(['/other'])), null);
  const undone = [e1, { ...e2, undo: { ...e2.undo, undone: 99 } }, e3];
  assert.equal(undoBlocker(undone, undone[1], none), 'undone');
  assert.equal(undoBlocker(undone, e1, none), null, 'once the newer edit is undone the older one is free');
  const elsewhere = [e1, edit('5', 'a.txt', { undo: { root: '/other', path: 'a.txt', before: B1, after: B2 } })];
  assert.equal(undoBlocker(elsewhere, e1, none), null, 'same name in another folder is another file');
  assert.equal(
    undoBlocker(log, edit('99', 'z.txt'), none),
    null,
    'an entry that is not in the list has nothing after it',
  );
});
