import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearTerminalCommands,
  hasTerminalCommands,
  needsTerminalConfirmation,
  normalizeTerminalCommand,
  requestTerminalCommand,
  takeTerminalCommands,
} from '../src/lib/terminalBridge.ts';

test('normalize drops trailing newlines and unifies line endings', () => {
  assert.equal(normalizeTerminalCommand('ls -la\n'), 'ls -la');
  assert.equal(normalizeTerminalCommand('\n\n  echo hi \r\n\r\n'), '  echo hi');
  assert.equal(normalizeTerminalCommand('a\rb'), 'a\nb');
});

test('only commands that would run or complete by themselves need confirmation', () => {
  assert.equal(needsTerminalConfirmation('npm test'), false);
  assert.equal(needsTerminalConfirmation('cd x\nls'), true);
  assert.equal(needsTerminalConfirmation('echo\tx'), true);
});

test('queue rejects empty, control-character and oversized commands, and is per root', () => {
  clearTerminalCommands();
  assert.throws(() => requestTerminalCommand('/p', '  \n'), /Invalid/);
  assert.throws(() => requestTerminalCommand('/p', 'ls\x1b[2J'), /Invalid/);
  assert.throws(() => requestTerminalCommand('', 'ls'), /Invalid/);
  assert.throws(() => requestTerminalCommand('/p', 'x'.repeat(70000)), /Invalid/);
  requestTerminalCommand('/p', 'ls\n');
  requestTerminalCommand('/q', 'pwd');
  assert.equal(hasTerminalCommands('/p'), true);
  assert.deepEqual(
    takeTerminalCommands('/p').map((c) => c.command),
    ['ls'],
  );
  assert.equal(hasTerminalCommands('/p'), false);
  assert.equal(hasTerminalCommands('/q'), true);
  clearTerminalCommands();
});

test('the queue is capped', () => {
  clearTerminalCommands();
  for (let i = 0; i < 32; i++) requestTerminalCommand('/p', `echo ${i}`);
  assert.throws(() => requestTerminalCommand('/p', 'one more'), /Too many/);
  clearTerminalCommands();
});
