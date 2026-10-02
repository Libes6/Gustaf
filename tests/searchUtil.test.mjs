import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARK_OPEN, MARK_CLOSE, MIN_QUERY_CHARS, RESULT_LIMIT,
  parseSnippet, searchableQuery, moveHighlight, nearestMessageId, turnHasMessage, isSearchShortcut,
} from '../src/lib/searchUtil.ts';

const hit = (s) => `${MARK_OPEN}${s}${MARK_CLOSE}`;

test('snippet markers match the ones db.rs sends', async () => {
  const { readFileSync } = await import('node:fs');
  const rust = readFileSync(new URL('../src-tauri/src/db.rs', import.meta.url), 'utf8');
  assert.equal(MARK_OPEN, '\u0001');
  assert.equal(MARK_CLOSE, '\u0002');
  assert.match(rust, /pub const MARK_OPEN: char = '\\u\{1\}';/);
  assert.match(rust, /pub const MARK_CLOSE: char = '\\u\{2\}';/);
  assert.equal(RESULT_LIMIT <= 100, true, 'db.rs clamps the limit to 100');
});

test('parseSnippet splits plain and highlighted runs', () => {
  assert.deepEqual(parseSnippet(`before ${hit('match')} after`), [
    { text: 'before ', hit: false },
    { text: 'match', hit: true },
    { text: ' after', hit: false },
  ]);
  assert.deepEqual(parseSnippet(`${hit('a')} and ${hit('b')}`), [
    { text: 'a', hit: true },
    { text: ' and ', hit: false },
    { text: 'b', hit: true },
  ]);
  assert.deepEqual(parseSnippet('no matches at all'), [{ text: 'no matches at all', hit: false }]);
  assert.deepEqual(parseSnippet(''), []);
});

test('parseSnippet collapses whitespace and trims the ends', () => {
  assert.deepEqual(parseSnippet(`…\n  line one\n\nline  ${hit('two')}\t\tend  `), [
    { text: '… line one line ', hit: false },
    { text: 'two', hit: true },
    { text: ' end', hit: false },
  ]);
  assert.deepEqual(parseSnippet(`  ${hit('x')}  `), [{ text: 'x', hit: true }], 'blank runs at the ends are dropped');
});

test('parseSnippet tolerates unbalanced and empty markers', () => {
  assert.deepEqual(parseSnippet(`a ${MARK_OPEN}open never closed`), [
    { text: 'a ', hit: false },
    { text: 'open never closed', hit: true },
  ]);
  assert.deepEqual(parseSnippet(`stray ${MARK_CLOSE}close`), [{ text: 'stray close', hit: false }]);
  assert.deepEqual(parseSnippet(`${MARK_OPEN}${MARK_CLOSE}text`), [{ text: 'text', hit: false }]);
  assert.deepEqual(parseSnippet(`${hit('')}${hit('x')}`), [{ text: 'x', hit: true }]);
});

test('parseSnippet keeps markup-looking text as plain text (the UI renders it as text, not HTML)', () => {
  assert.deepEqual(parseSnippet(`<b>${hit('<script>')}</b>`), [
    { text: '<b>', hit: false },
    { text: '<script>', hit: true },
    { text: '</b>', hit: false },
  ]);
  assert.deepEqual(parseSnippet(`${hit('Привет')} мир 😀`), [
    { text: 'Привет', hit: true },
    { text: ' мир 😀', hit: false },
  ]);
});

test('searchableQuery needs two characters with a letter or digit', () => {
  assert.equal(MIN_QUERY_CHARS, 2);
  assert.equal(searchableQuery(''), null);
  assert.equal(searchableQuery('   '), null);
  assert.equal(searchableQuery('a'), null);
  assert.equal(searchableQuery(' a '), null);
  assert.equal(searchableQuery('--'), null);
  assert.equal(searchableQuery('"" ()'), null);
  assert.equal(searchableQuery('ab'), 'ab');
  assert.equal(searchableQuery('  hello world  '), 'hello world');
  assert.equal(searchableQuery('a1'), 'a1');
  assert.equal(searchableQuery('мир'), 'мир');
  assert.equal(searchableQuery('日本'), '日本');
  assert.equal(searchableQuery('😀😀'), null, 'emoji alone have no letters');
  assert.equal(searchableQuery('"exact phrase"'), '"exact phrase"', 'the raw text is passed on; escaping is done in Rust');
});

test('moveHighlight wraps around and recovers from a stale index', () => {
  assert.equal(moveHighlight(0, 1, 3), 1);
  assert.equal(moveHighlight(2, 1, 3), 0);
  assert.equal(moveHighlight(0, -1, 3), 2);
  assert.equal(moveHighlight(1, -1, 3), 0);
  assert.equal(moveHighlight(0, 1, 1), 0);
  assert.equal(moveHighlight(0, -1, 1), 0);
  assert.equal(moveHighlight(5, 1, 3), 0, 'index beyond the list (results shrank) goes to the first row');
  assert.equal(moveHighlight(5, -1, 3), 2, 'and up goes to the last row');
  assert.equal(moveHighlight(-1, 1, 3), 0);
  assert.equal(moveHighlight(0, 1, 0), 0, 'empty list');
  assert.equal(moveHighlight(1, 7, 3), 2);
  assert.equal(moveHighlight(1, -7, 3), 0);
});

test('nearestMessageId prefers the match, then the closest earlier message, then a later one', () => {
  assert.equal(nearestMessageId([3, 5, 9], 5), 5);
  assert.equal(nearestMessageId([3, 5, 9], 7), 5, 'rewound: stay just before the removed message');
  assert.equal(nearestMessageId([3, 5, 9], 100), 9);
  assert.equal(nearestMessageId([3, 5, 9], 1), 3, 'nothing earlier: first later message');
  assert.equal(nearestMessageId([9, 3, 5], 7), 5, 'order does not matter');
  assert.equal(nearestMessageId([], 5), null);
  assert.equal(nearestMessageId([4], 4), 4);
});

test('turnHasMessage finds the user message and any reply step', () => {
  const turn = { user: { id: 1 }, steps: [{ id: 2 }, { id: 3 }] };
  assert.equal(turnHasMessage(turn, 1), true);
  assert.equal(turnHasMessage(turn, 3), true);
  assert.equal(turnHasMessage(turn, 4), false);
  assert.equal(turnHasMessage({ steps: [{ id: 7 }] }, 7), true, 'a turn can start with an assistant message');
  assert.equal(turnHasMessage({ steps: [] }, 7), false);
});

test('isSearchShortcut is Cmd+K on any keyboard layout', () => {
  const key = (o) => ({ key: 'k', code: 'KeyK', metaKey: true, shiftKey: false, altKey: false, ...o });
  assert.equal(isSearchShortcut(key({})), true);
  assert.equal(isSearchShortcut(key({ key: 'K' })), true, 'caps lock');
  assert.equal(isSearchShortcut(key({ key: 'л', code: 'KeyK' })), true, 'Russian layout');
  assert.equal(isSearchShortcut(key({ key: 'k', code: undefined })), true, 'no code available');
  assert.equal(isSearchShortcut(key({ metaKey: false })), false);
  assert.equal(isSearchShortcut(key({ shiftKey: true })), false);
  assert.equal(isSearchShortcut(key({ altKey: true })), false);
  assert.equal(isSearchShortcut(key({ key: 'n', code: 'KeyN' })), false);
  assert.equal(isSearchShortcut(key({ key: 'л', code: undefined })), false);
});
