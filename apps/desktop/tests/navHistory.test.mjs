import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyNav, move, NAV_LIMIT, visit } from '../src/lib/navHistory.ts';

const e = (chatId) => ({ chatId, projectId: null });
const all = () => true;

test('back and forward walk the visited chats; a new visit drops the forward part', () => {
  let nav = [1, 2, 3].reduce((n, id) => visit(n, e(id)), emptyNav);
  let r = move(nav, -1, all);
  assert.equal(r.entry.chatId, 2);
  nav = r.nav;
  r = move(nav, -1, all);
  assert.equal(r.entry.chatId, 1);
  nav = r.nav;
  assert.equal(move(nav, -1, all), null);
  r = move(nav, 1, all);
  assert.equal(r.entry.chatId, 2);
  nav = r.nav;
  nav = visit(nav, e(9));
  assert.deepEqual(
    nav.items.map((x) => x.chatId),
    [1, 2, 9],
  );
  assert.equal(move(nav, 1, all), null);
});

test('repeats collapse, deleted chats are skipped, the history is bounded', () => {
  let nav = visit(visit(emptyNav, e(1)), e(1));
  assert.equal(nav.items.length, 1);
  nav = [2, 3].reduce((n, id) => visit(n, e(id)), nav);
  assert.equal(move(nav, -1, (id) => id !== 2).entry.chatId, 1);
  nav = Array.from({ length: NAV_LIMIT + 10 }, (_, i) => i + 1).reduce((n, id) => visit(n, e(id)), emptyNav);
  assert.equal(nav.items.length, NAV_LIMIT);
  assert.equal(nav.index, NAV_LIMIT - 1);
});
