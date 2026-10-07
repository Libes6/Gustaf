import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicLevels, claudeCliLevels, codexLevels, cursorLevels, cursorModel, defaultLevel, openRouterEffort, pickLevel, rememberEfforts, reportedEffort, sdkEffort, specLevels } from '../src/providers/reasoning.ts';

const ALL = ['low', 'medium', 'high', 'xhigh', 'max'];

test('Anthropic levels follow the model generation', () => {
  for (const m of ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-1', 'claude-mythos-5-1']) assert.deepEqual(anthropicLevels(m), ALL, m);
  assert.deepEqual(anthropicLevels('claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(anthropicLevels('claude-sonnet-4-6'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(anthropicLevels('claude-opus-4-5-20251101'), ['low', 'medium', 'high']);
  for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'gpt-5']) assert.deepEqual(anthropicLevels(m), [], m);
});

test('Claude Code aliases get every level except haiku', () => {
  for (const m of ['default', 'opus', 'sonnet']) assert.deepEqual(claudeCliLevels(m), ALL, m);
  assert.deepEqual(claudeCliLevels('haiku'), []);
  assert.deepEqual(claudeCliLevels('claude-opus-4-6'), ['low', 'medium', 'high', 'max']);
});

test('Codex offers low/medium/high; Cursor only for Claude and GPT-5+ ids', () => {
  assert.deepEqual(codexLevels('gpt-5.5-codex'), ['low', 'medium', 'high']);
  assert.deepEqual(cursorLevels('claude-opus-4-8'), ['low', 'medium', 'high']);
  assert.deepEqual(cursorLevels('claude-opus-5-5', ['claude-opus-5-5', 'gpt-5.2']), ['low', 'medium', 'high']);
  assert.deepEqual(cursorLevels('gpt-5.2', ['gpt-5.2', 'gpt-5.2-high', 'gpt-5.2-low-fast']), [], 'old scheme: plain id beside its variants');
  assert.deepEqual(cursorLevels('claude-4-sonnet'), [], 'old-style Claude ids');
  assert.deepEqual(cursorLevels('gpt-5'), ['low', 'medium', 'high']);
  for (const m of ['auto', 'composer-2', 'grok-4', 'claude-haiku-4-5', 'claude-opus-4-8[effort=high]', 'claude-opus-4-8-high', 'claude-opus-4-8-thinking-max-fast', 'gpt-5.5-extra-high', 'gpt-5.6-sol-none-fast', 'claude-4.6-sonnet-medium']) assert.deepEqual(cursorLevels(m), [], m);
});

test('Cursor model id carries the effort override except for medium', () => {
  assert.equal(cursorModel('claude-opus-4-8', 'high'), 'claude-opus-4-8[effort=high]');
  assert.equal(cursorModel('claude-opus-4-8', 'medium'), 'claude-opus-4-8');
  assert.equal(cursorModel('claude-opus-4-8', undefined), 'claude-opus-4-8');
  assert.equal(cursorModel('auto', 'high'), 'auto');
  assert.equal(cursorModel('claude-opus-4-8-high', 'low'), 'claude-opus-4-8-high', 'an id that names its level is sent unchanged');
  assert.equal(cursorModel('gpt-5', 'max'), 'gpt-5', 'callers snap first; an unknown level is not sent');
});

test('pickLevel snaps to the nearest offered level, ties going lower', () => {
  assert.equal(pickLevel('xhigh', ['low', 'medium', 'high']), 'high');
  assert.equal(pickLevel('xhigh', ['low', 'medium', 'high', 'max']), 'high');
  assert.equal(pickLevel('max', ['low', 'medium', 'high']), 'high');
  assert.equal(pickLevel('medium', ALL), 'medium');
  assert.equal(pickLevel('high', []), undefined);
  assert.equal(pickLevel(undefined, ALL), undefined);
  assert.equal(defaultLevel(ALL), 'medium');
  assert.equal(defaultLevel(['high', 'max']), 'high');
});

const param = (id, ...values) => ({ id, values: values.map((value) => ({ value })) });

test('Cursor SDK: the effort parameter of a model becomes its level list', () => {
  const spec = sdkEffort([param('fast', 'true', 'false'), param('reasoning_effort', 'low', 'medium', 'high', 'extra-high', 'bogus')]);
  assert.deepEqual(spec, { param: 'reasoning_effort', values: { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra-high' } });
  assert.deepEqual(specLevels(spec), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(specLevels(sdkEffort([param('effort', 'max', 'low')])), ['low', 'max'], 'always weakest first');
});

test('Cursor SDK: no effort parameter, or fewer than two usable stops, means no level', () => {
  for (const bad of [undefined, null, 'x', [], [param('fast', 'true', 'false')], [param('effort', 'high')], [param('effort', 'on', 'off')], [{ id: 'effort' }], [null]]) assert.equal(sdkEffort(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(specLevels(undefined), []);
});

test('OpenRouter: only a model listing `reasoning` offers low/medium/high', () => {
  assert.deepEqual(specLevels(openRouterEffort(['tools', 'reasoning'])), ['low', 'medium', 'high']);
  for (const bad of [['tools'], ['include_reasoning'], undefined, 'reasoning']) assert.equal(openRouterEffort(bad), undefined);
});

test('reported efforts are remembered per provider and replaced by the next list', () => {
  const spec = { param: 'effort', values: { low: 'low', high: 'high' } };
  const info = (providerId, id, effort) => ({ id, name: id, providerId, created: 0, effort });
  rememberEfforts([info('a', 'm1', spec), info('a', 'm2'), info('b', 'm1', spec)]);
  assert.deepEqual(reportedEffort('a', 'm1'), spec);
  assert.equal(reportedEffort('a', 'm2'), undefined);
  rememberEfforts([info('a', 'm1')]);
  assert.equal(reportedEffort('a', 'm1'), undefined, 'a newer list of provider a replaces the old one');
  assert.deepEqual(reportedEffort('b', 'm1'), spec, 'other providers keep theirs');
  rememberEfforts([]);
});
