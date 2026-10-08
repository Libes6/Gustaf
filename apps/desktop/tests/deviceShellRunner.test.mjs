// The real command runner of the device driver (src/device/shellRunner.ts) on fake processes: output collected from the
// raw stdout lines, exit code, timeout stops the process tree gracefully, detached returns at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { shell, fakeProcess, installSignals } = await import('./helpers/shellStub.mjs');
installSignals();
const { setPlatformForTests } = await import('../src/lib/platform.ts');
const { createShellRunner } = await import('../src/device/shellRunner.ts');
setPlatformForTests('macos');

test('collects stdout lines and the exit code, forwards each line to onLine', async () => {
  const procs = [];
  shell.handler = { spawn: () => (procs.push(fakeProcess()), procs.at(-1)) };
  const seen = [];
  const run = createShellRunner();
  const p = run('echo hi', { onLine: (l) => seen.push(l) });
  await new Promise((r) => setTimeout(r, 5));
  procs[0].line({ a: 1 });
  procs[0].line({ b: 2 });
  procs[0].exit(0);
  const r = await p;
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '{"a":1}\n{"b":2}');
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}']);
  assert.equal(r.timedOut, undefined);
  assert.match(shell.spawned.at(-1).script, /echo hi/);
});

test('a timeout stops the process with SIGTERM and reports timedOut', async () => {
  const procs = [];
  shell.handler = { spawn: () => (procs.push(fakeProcess()), procs.at(-1)) };
  const r = await createShellRunner()('sleep 100', { timeoutMs: 20 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(procs[0].signals.slice(0, 1), ['term']);
});

test('detached: returns at once, the process keeps running', async () => {
  const procs = [];
  shell.handler = { spawn: () => (procs.push(fakeProcess()), procs.at(-1)) };
  const r = await createShellRunner()('emulator -avd X', { detached: true });
  assert.deepEqual(r, { code: 0, stdout: '', stderr: '' });
  assert.equal(procs[0].exited(), false);
  procs[0].exit(0);
});
