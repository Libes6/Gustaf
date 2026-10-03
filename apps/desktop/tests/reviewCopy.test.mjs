// Review copy for chats: only the global setting counts (off unless set to exactly true). The old per-chat overrides
// (setting `chatReviewOverrides`) are never read and are deleted once at startup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { state } = await import('./helpers/apiStub.mjs');
const { resolveReviewCopy, REVIEW_COPY_DEFAULT, LEGACY_OVERRIDES_KEY, removeLegacyReviewOverrides } = await import('../src/lib/reviewCopy.ts');

test('the default is off for new and existing installs (no stored value)', () => {
  assert.equal(REVIEW_COPY_DEFAULT, false);
  assert.equal(resolveReviewCopy(undefined), false);
  assert.equal(resolveReviewCopy(false), false);
  assert.equal(resolveReviewCopy('yes'), false, 'only a real true turns it on');
});

test('the global setting alone decides', () => {
  assert.equal(resolveReviewCopy(true), true);
  assert.equal(resolveReviewCopy(false), false);
});

test('the legacy per-chat override key is removed once and leaves other settings alone', async () => {
  state.reset();
  assert.equal(LEGACY_OVERRIDES_KEY, 'chatReviewOverrides');
  state.settings.set('chatReviewOverrides', JSON.stringify({ 3: 'maybe', 4: 'on' }));
  state.settings.set('reviewCopy', JSON.stringify(true));
  await removeLegacyReviewOverrides();
  assert.equal(state.settings.has('chatReviewOverrides'), false);
  assert.equal(state.settings.get('reviewCopy'), 'true');
  await removeLegacyReviewOverrides(); // nothing left: still fine
});
