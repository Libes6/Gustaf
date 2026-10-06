import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropicLevels, claudeCliLevels, codexLevels, cursorLevels, cursorModel, defaultLevel, pickLevel } from '../src/providers/reasoning.ts';

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
  assert.deepEqual(cursorLevels('gpt-5'), ['low', 'medium', 'high']);
  for (const m of ['auto', 'composer-2', 'grok-4', 'claude-haiku-4-5', 'claude-opus-4-8[effort=high]']) assert.deepEqual(cursorLevels(m), [], m);
});

test('Cursor model id carries the effort override except for medium', () => {
  assert.equal(cursorModel('claude-opus-4-8', 'high'), 'claude-opus-4-8[effort=high]');
  assert.equal(cursorModel('claude-opus-4-8', 'medium'), 'claude-opus-4-8');
  assert.equal(cursorModel('claude-opus-4-8', undefined), 'claude-opus-4-8');
  assert.equal(cursorModel('auto', 'high'), 'auto');
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
