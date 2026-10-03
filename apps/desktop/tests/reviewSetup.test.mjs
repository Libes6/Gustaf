import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandAllowed, commandNeedsApproval, commandVerdict } from '../src/lib/commandRules.ts';
import {
  clipOutput, hasReviewSetup, MAX_LINK_DIRS, normalizeLinkDir, normalizeReviewSetup, OUTPUT_LIMIT, parseLinkDirs, summarizeRun,
} from '../src/lib/reviewSetup.ts';

test('link directories are normalized to plain project-relative paths', () => {
  assert.equal(normalizeLinkDir('node_modules'), 'node_modules');
  assert.equal(normalizeLinkDir(' ./packages//a/node_modules/ '), 'packages/a/node_modules');
  for (const bad of ['', '  ', '.', '/', '/etc', '../x', 'a/../b', '.git', 'a/.git/hooks', 'a\\b', 'a\0b']) assert.equal(normalizeLinkDir(bad), null, JSON.stringify(bad));
});

test('parseLinkDirs accepts lines and commas, drops invalid and duplicate entries and caps the count', () => {
  assert.deepEqual(parseLinkDirs('node_modules\n./node_modules, vendor\n../out\n/abs\n\n.venv'), ['node_modules', 'vendor', '.venv']);
  const many = Array.from({ length: MAX_LINK_DIRS + 5 }, (_, i) => `d${i}`).join('\n');
  assert.equal(parseLinkDirs(many).length, MAX_LINK_DIRS);
});

test('normalizeReviewSetup repairs garbage and trims commands', () => {
  assert.deepEqual(normalizeReviewSetup(null), { linkDirs: [], setupCommand: '', testCommand: '' });
  assert.deepEqual(normalizeReviewSetup('x'), { linkDirs: [], setupCommand: '', testCommand: '' });
  assert.deepEqual(
    normalizeReviewSetup({ linkDirs: ['node_modules', 5, '../bad'], setupCommand: '  npm ci ', testCommand: 7 }),
    { linkDirs: ['node_modules'], setupCommand: 'npm ci', testCommand: '' },
  );
  assert.equal(normalizeReviewSetup({ testCommand: 'x'.repeat(5000) }).testCommand.length, 2000);
  assert.ok(!hasReviewSetup(normalizeReviewSetup({})));
  assert.ok(hasReviewSetup(normalizeReviewSetup({ testCommand: 'npm test' })));
});

test('command approval follows the agent rules: only ask mode asks, allowlist prefixes pass', () => {
  const list = ['npm test', 'ls'];
  assert.ok(commandAllowed('npm test', list) && commandAllowed('npm test -- --watch=false', list));
  assert.ok(!commandAllowed('npm testing', list) && !commandAllowed('rm -rf /', list));
  assert.equal(commandNeedsApproval('auto', 'npm test', list), false);
  assert.equal(commandNeedsApproval('auto', 'npm run evil', list), true);
  assert.equal(commandNeedsApproval('full', 'npm run evil', list), false);
  assert.equal(commandVerdict('readonly', 'npm run evil', list), 'block');
  assert.equal(commandVerdict('full', 'sudo ls', list), 'block');
  assert.equal(commandVerdict('auto', 'npm test && rm -rf x', list), 'ask');
});

test('output is clipped to its tail and run results are summarized', () => {
  assert.equal(clipOutput('short'), 'short');
  const long = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
  const clipped = clipOutput(long);
  assert.ok(clipped.length <= OUTPUT_LIMIT + 3);
  assert.ok(clipped.startsWith('…\nline '));
  assert.ok(clipped.endsWith('line 1999'));
  assert.ok(summarizeRun('npm test', { code: 0, output: 'ok', timed_out: false }).ok);
  assert.ok(!summarizeRun('npm test', { code: 1, output: 'bad', timed_out: false }).ok);
  assert.ok(!summarizeRun('npm test', { code: null, output: '', timed_out: true }).ok);
  assert.equal(summarizeRun('npm test', { code: 0, output: 'x', timed_out: true }).timedOut, true);
});
