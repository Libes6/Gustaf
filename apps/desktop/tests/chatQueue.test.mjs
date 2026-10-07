import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { loadQueue, getQueue, updateQueue, validateQueue } = await import('../src/lib/chatQueue.ts');
const item = (id, text = id) => ({ id, text, images: [], clarify: false });
test('restored queue retains FIFO but pauses explicitly and exposes interrupted run', async () => {
  state.settings.set(
    'chat-queue-2001',
    JSON.stringify({ items: [item('a'), item('b')], paused: false, interrupted: true }),
  );
  await loadQueue(2001);
  assert.deepEqual(
    getQueue(2001).items.map((i) => i.id),
    ['a', 'b'],
  );
  assert.equal(getQueue(2001).paused, true);
  assert.equal(getQueue(2001).interrupted, true);
  await updateQueue(2001, (q) => ({ ...q, items: q.items.map((i) => (i.id === 'a' ? { ...i, text: 'edited' } : i)) }));
  await updateQueue(2001, (q) => ({ ...q, items: q.items.filter((i) => i.id !== 'b') }));
  assert.equal(JSON.parse(state.settings.get('chat-queue-2001')).items[0].text, 'edited');
  assert.equal(JSON.parse(state.settings.get('chat-queue-2001')).items.length, 1);
});
test('hydration cannot overwrite a newly enqueued item', async () => {
  state.settings.set('chat-queue-2002', JSON.stringify({ items: [item('old')], paused: false }));
  const loading = loadQueue(2002);
  await updateQueue(2002, (q) => ({ ...q, items: [item('new')] }));
  await loading;
  assert.equal(getQueue(2002).items[0].id, 'new');
});
test('malformed saved queue is safe and bounded', () => {
  assert.deepEqual(validateQueue(null).items, []);
  assert.equal(validateQueue({ active: true, items: [] }).interrupted, true);
  assert.equal(validateQueue({ active: true, items: [] }).active, false);
  assert.deepEqual(validateQueue({ items: [null, {}, item('ok')] }).items, [item('ok')]);
  assert.equal(validateQueue({ items: Array.from({ length: 150 }, (_, i) => item(String(i))) }).items.length, 100);
});
