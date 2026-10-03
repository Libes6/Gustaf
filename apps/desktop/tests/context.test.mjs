import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveHistory, estimateContext, modelMetadata, summaryChunks } from '../src/lib/context.ts';
test('summary excludes previous tool/session history while preserving originals and subsequent sessions', () => {
  const original = { role: 'assistant', parts: [{ type: 'text', text: 'long conversation' }], meta: { responseId: 'old' } };
  const summary = { role: 'user', parts: [{ type: 'text', text: 'summary' }], meta: { compacted: true } };
  const next = { role: 'assistant', parts: [{ type: 'text', text: 'new response' }], meta: { responseId: 'new' } };
  const history = [original, summary, next];
  assert.deepEqual(effectiveHistory(history), [summary, next]);
  assert.equal(history.length, 3);
  assert.equal(effectiveHistory(history)[0].meta.responseId, undefined);
  assert.ok(estimateContext(history, 'draft') > estimateContext(effectiveHistory(history)));
});
test('long history and a single oversized message are split without discarding text', () => {
  const content = 'очень длинное сообщение '.repeat(3000);
  const chunks = summaryChunks([{ role: 'user', parts: [{ type: 'text', text: content }] }], 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 3000));
  assert.equal(chunks.join(''), `USER:\n${content}\n\n`);
});
test('model metadata distinguishes unsupported, unknown and provider reported capabilities', () => {
  assert.deepEqual(modelMetadata({ id: 'unknown' }), { contextWindow: undefined, images: undefined, tools: undefined });
  assert.deepEqual(modelMetadata({ context_length: 32000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] }), { contextWindow: 32000, images: true, tools: true });
  assert.equal(modelMetadata({ architecture: { input_modalities: ['text'] } }).images, false);
  assert.equal(modelMetadata({ context_window: -1 }).contextWindow, undefined);
});
