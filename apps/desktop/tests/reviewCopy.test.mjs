// Review copy for chats: the chat's override wins over the global setting, which is off unless set to exactly true;
// the per-chat overrides persist in the settings table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { resolveReviewCopy, REVIEW_COPY_DEFAULT, loadReviewOverride, saveReviewOverride } = await import('../src/lib/reviewCopy.ts');

test('the default is off for new and existing installs (no stored value)', () => {
  assert.equal(REVIEW_COPY_DEFAULT, false);
  assert.equal(resolveReviewCopy(undefined, undefined), false);
  assert.equal(resolveReviewCopy(null, false), false);
  assert.equal(resolveReviewCopy(undefined, 'yes'), false, 'only a real true turns it on');
});

test('override ?? global', () => {
  assert.equal(resolveReviewCopy(undefined, true), true);
  assert.equal(resolveReviewCopy(null, true), true);
  assert.equal(resolveReviewCopy('on', false), true);
  assert.equal(resolveReviewCopy('off', true), false);
  assert.equal(resolveReviewCopy('off', false), false);
  assert.equal(resolveReviewCopy('on', true), true);
});

test('overrides persist per chat, can be cleared, and junk is ignored', async () => {
  state.reset();
  assert.equal(await loadReviewOverride(1), undefined);
  await saveReviewOverride(1, 'off');
  await saveReviewOverride(2, 'on');
  assert.equal(await loadReviewOverride(1), 'off');
  assert.equal(await loadReviewOverride(2), 'on');
  await saveReviewOverride(1, undefined);
  assert.equal(await loadReviewOverride(1), undefined);
  assert.equal(await loadReviewOverride(2), 'on');
  state.settings.set('chatReviewOverrides', JSON.stringify({ 3: 'maybe', 4: 'on' }));
  assert.equal(await loadReviewOverride(3), undefined);
  assert.equal(await loadReviewOverride(4), 'on');
});
