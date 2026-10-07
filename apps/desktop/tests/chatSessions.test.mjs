import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  openSession,
  promoteSession,
  isAuthError,
  DRAFT_LIMITS,
  draftScope,
  parseScope,
  boundDraft,
  serializeDraft,
  parseDraft,
  isEmptyDraft,
  createDraftSaver,
} from '../src/lib/chatSessions.ts';
test('late chat creation preserves a newer active draft and stable session key', () => {
  const initial = { active: 'a', items: [{ key: 'a', chatId: null, projectId: null }] };
  const sending = promoteSession(initial, 'a', 1);
  const next = openSession(sending, null, null, 'b');
  assert.equal(next.active, 'b');
  assert.equal(promoteSession(next, 'a', 1).active, 'b');
  assert.equal(openSession(next, 1, null, 'unused').active, 'a');
  assert.equal(openSession(next, null, null, 'unused').items.length, 2);
});
test('project drafts stay separate and authentication errors are classified', () => {
  let s = { active: 'a', items: [{ key: 'a', chatId: null, projectId: null }] };
  s = openSession(s, null, 4, 'project');
  assert.equal(s.items.length, 2);
  assert.equal(isAuthError('HTTP 401: OAuth access token is invalid'), true);
  assert.equal(isAuthError('HTTP 429 rate limit'), false);
  assert.equal(isAuthError('HTTP 500 server error'), false);
});

test('new chat during async creation does not reuse a busy draft', () => {
  const state = { active: 'sending', items: [{ key: 'sending', chatId: null, projectId: null, busy: true }] };
  const next = openSession(state, null, null, 'new');
  assert.equal(next.active, 'new');
  assert.equal(next.items.length, 2);
  assert.equal(promoteSession(next, 'sending', 22).active, 'new');
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (n) => 'A'.repeat(n);

test('draft scopes distinguish chats, project drafts and the global new-chat draft', () => {
  assert.equal(draftScope(7, 3), 'chat:7');
  assert.equal(draftScope(null, 3), 'new:3');
  assert.equal(draftScope(null, null), 'new:');
  assert.deepEqual(parseScope('chat:7'), { chatId: 7, projectId: null });
  assert.deepEqual(parseScope('new:3'), { chatId: null, projectId: 3 });
  assert.deepEqual(parseScope('new:'), { chatId: null, projectId: null });
  assert.deepEqual(parseScope('chat:x'), { chatId: null, projectId: null });
});

test('draft bounds drop oversized attachments, respect the total budget and count, and cut text safely', () => {
  const small = b64(100);
  const huge = b64(DRAFT_LIMITS.image + 1);
  const r = boundDraft({ text: 'hi', images: [small, huge, small] });
  assert.deepEqual(r.images, [small, small]);
  assert.equal(r.dropped, 1);
  assert.equal(r.truncated, false);

  const big = b64(DRAFT_LIMITS.image);
  const budget = boundDraft({ text: '', images: [big, big, big] });
  assert.equal(budget.images.length, Math.floor(DRAFT_LIMITS.images / DRAFT_LIMITS.image));
  assert.equal(budget.dropped, 3 - budget.images.length);
  // A later small attachment still fits the remaining budget.
  assert.equal(boundDraft({ text: '', images: [big, big, big, small] }).images.at(-1), small);

  const many = boundDraft({ text: '', images: Array.from({ length: DRAFT_LIMITS.count + 3 }, () => 'QQ==') });
  assert.equal(many.images.length, DRAFT_LIMITS.count);
  assert.equal(many.dropped, 3);

  const long = 'x'.repeat(DRAFT_LIMITS.text - 1) + '\u{1F600}tail';
  const cut = boundDraft({ text: long, images: [] });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, DRAFT_LIMITS.text - 1, 'a split surrogate pair is removed');
  assert.equal(boundDraft({ text: '', images: [''] }).images.length, 0);
});

test('draft serialization round-trips and empty drafts are not stored', () => {
  assert.equal(serializeDraft({ text: '', images: [] }), null);
  assert.equal(serializeDraft({ text: '  \n ', images: [] }), null);
  assert.equal(isEmptyDraft({ text: '', images: ['QQ=='] }), false);

  const textOnly = serializeDraft({ text: 'hello', images: [] });
  assert.deepEqual(textOnly, { text: 'hello', attachments: '[]' });
  assert.deepEqual(parseDraft(textOnly.text, textOnly.attachments), { text: 'hello', images: [] });

  const row = serializeDraft({ text: '', images: ['QUJD', 'REVG'] });
  assert.deepEqual(JSON.parse(row.attachments), [
    { type: 'image', data: 'QUJD' },
    { type: 'image', data: 'REVG' },
  ]);
  assert.deepEqual(parseDraft(row.text, row.attachments), { text: '', images: ['QUJD', 'REVG'] });

  // Oversized attachments never reach the database.
  const withHuge = serializeDraft({ text: 'keep', images: [b64(DRAFT_LIMITS.image + 4)] });
  assert.deepEqual(withHuge, { text: 'keep', attachments: '[]' });
});

test('stored drafts that are corrupt or hand-edited restore as much as is safe', () => {
  assert.equal(parseDraft('', '[]'), null);
  assert.equal(parseDraft(null, null), null);
  assert.deepEqual(parseDraft('typed', '{not json'), { text: 'typed', images: [] });
  assert.deepEqual(parseDraft('typed', '{"type":"image"}'), { text: 'typed', images: [] });
  const mixed = JSON.stringify([
    { type: 'image', data: 'QUJD' },
    { type: 'file', data: 'QUJD' },
    { type: 'image', data: 'not base64!' },
    { type: 'image', data: 42 },
    null,
    'QUJD',
  ]);
  assert.deepEqual(parseDraft('', mixed), { text: '', images: ['QUJD'] });
});

function recorder(opts = {}) {
  const calls = [];
  const saver = createDraftSaver(
    async (scope, row) => {
      calls.push([scope, row]);
      if (opts.fail?.()) throw new Error('db down');
    },
    { delayMs: 15, onError: opts.onError },
  );
  return { calls, saver };
}

test('draft saver debounces rapid edits into one write and sends only the final state', async () => {
  const { calls, saver } = recorder();
  saver.schedule('chat:1', { text: 'a', images: [] });
  saver.schedule('chat:1', { text: 'ab', images: [] });
  saver.schedule('chat:1', { text: 'abc', images: ['QUJD'] });
  assert.equal(calls.length, 0, 'nothing is written before the debounce elapses');
  await sleep(60);
  await saver.flush();
  assert.deepEqual(calls, [
    ['chat:1', { text: 'abc', attachments: JSON.stringify([{ type: 'image', data: 'QUJD' }]) }],
  ]);
});

test('draft saver omits unchanged attachments, skips no-op writes and deletes empty drafts', async () => {
  const { calls, saver } = recorder();
  const att = JSON.stringify([{ type: 'image', data: 'QUJD' }]);
  saver.schedule('chat:1', { text: 'a', images: ['QUJD'] });
  await saver.flush('chat:1');
  saver.schedule('chat:1', { text: 'ab', images: ['QUJD'] });
  await saver.flush();
  saver.schedule('chat:1', { text: 'ab', images: ['QUJD'] });
  await saver.flush();
  saver.schedule('chat:1', { text: 'ab', images: [] });
  await saver.flush();
  saver.schedule('chat:1', { text: '', images: [] });
  await saver.flush();
  saver.schedule('chat:1', { text: ' ', images: [] });
  await saver.flush();
  assert.deepEqual(calls, [
    ['chat:1', { text: 'a', attachments: att }],
    ['chat:1', { text: 'ab' }],
    ['chat:1', { text: 'ab', attachments: '[]' }],
    ['chat:1', null],
  ]);
});

test('draft saver trusts only what it was told about the database', async () => {
  const { calls, saver } = recorder();
  // Unknown scope: an empty composer still deletes whatever may be stored; text-only edits send attachments too.
  saver.schedule('chat:1', { text: '', images: [] });
  await saver.flush();
  saver.schedule('chat:2', { text: 'x', images: [] });
  await saver.flush();
  assert.deepEqual(calls, [
    ['chat:1', null],
    ['chat:2', { text: 'x', attachments: '[]' }],
  ]);

  // Seeded with the restored draft: re-saving the same content is a no-op, an edit sends text only.
  calls.length = 0;
  saver.seed('chat:3', { text: 'restored', images: ['QUJD'] });
  saver.schedule('chat:3', { text: 'restored', images: ['QUJD'] });
  await saver.flush();
  assert.equal(calls.length, 0);
  saver.schedule('chat:3', { text: 'restored more', images: ['QUJD'] });
  await saver.flush();
  assert.deepEqual(calls, [['chat:3', { text: 'restored more' }]]);
});

test('draft saver clear cancels a pending edit and deletes the stored row', async () => {
  const { calls, saver } = recorder();
  saver.seed('chat:1', { text: 'old', images: [] });
  saver.schedule('chat:1', { text: 'being sent', images: [] });
  await saver.clear('chat:1');
  await sleep(40);
  assert.deepEqual(calls, [['chat:1', null]], 'the pending edit never reaches the database');
  await saver.clear('chat:1');
  assert.equal(calls.length, 1, 'clearing an already empty draft is free');
});

test('draft saver writes sequentially and survives write failures', async () => {
  const errors = [];
  let fail = true;
  const order = [];
  const saver = createDraftSaver(
    async (scope, row) => {
      order.push(`start ${scope}`);
      await sleep(10);
      if (fail) throw new Error('db down');
      order.push(`end ${scope}:${row?.text}`);
    },
    { delayMs: 5, onError: (e) => errors.push(e.message) },
  );
  saver.schedule('chat:1', { text: 'one', images: [] });
  saver.schedule('chat:2', { text: 'two', images: [] });
  await sleep(30);
  await saver.flush();
  assert.deepEqual(errors, ['db down', 'db down']);
  assert.deepEqual(order, ['start chat:1', 'start chat:2'], 'second write starts only after the first failed');

  fail = false;
  order.length = 0;
  saver.schedule('chat:1', { text: 'one', images: [] });
  await sleep(30);
  await saver.flush();
  assert.deepEqual(order, ['start chat:1', 'end chat:1:one'], 'a failed write is retried in full on the next edit');
});
