// The real launcher script installed as `gustaf-agent` (src-tauri/src/device_bridge/bridge-launcher.sh) against a local
// HTTP server: the path per command, the arguments, stdin and plan-file input, errors. The server side is tested in Rust.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { hasSh, server, runLauncher } = await import('./helpers/launcher.mjs');
const env = (s) => ({ GUSTAF_BRIDGE_URL: s.url, GUSTAF_BRIDGE_TOKEN: 'tok' });

test('gustaf-agent posts to /v1/agent with the arguments in order', { skip: !hasSh }, async () => {
  const s = await server(() => ({ status: 200, text: 'Started task t1' }));
  try {
    const r = await runLauncher('gustaf-agent', env(s), [
      'spawn',
      '--model',
      'Composer 2',
      '--background',
      'run `ls` & "wait" $HOME\nline2',
    ]);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'Started task t1\n');
    assert.deepEqual(s.seen, [
      {
        method: 'POST',
        url: '/v1/agent',
        auth: 'Bearer tok',
        args: ['spawn', '--model', 'Composer 2', '--background', 'run `ls` & "wait" $HOME\nline2'],
      },
    ]);
  } finally {
    s.close();
  }
});

test('the same script as gustaf-device posts to /v1/device', { skip: !hasSh }, async () => {
  const s = await server(() => ({ status: 200, text: 'ok' }));
  try {
    await runLauncher('gustaf-device', env(s), ['list']);
    assert.equal(s.seen[0].url, '/v1/device');
  } finally {
    s.close();
  }
});

test('"-" sends stdin as the input', { skip: !hasSh }, async () => {
  const s = await server(() => ({ status: 200, text: 'ok' }));
  try {
    const task = 'a long task\nwith "quotes" and 100% of $things';
    await runLauncher('gustaf-agent', env(s), ['spawn', '-'], { stdin: task });
    assert.deepEqual(s.seen[0].args, ['spawn', '-']);
    assert.equal(s.seen[0].input, task);
  } finally {
    s.close();
  }
});

test(
  'delegate sends the plan file named on the command line; a missing file sends no input',
  { skip: !hasSh },
  async () => {
    const s = await server(() => ({ status: 200, text: 'ok' }));
    try {
      const dir = mkdtempSync(join(tmpdir(), 'plan-'));
      const plan = '{"tasks":[{"id":"a","title":"A","prompt":"x","type":"explore"}]}';
      writeFileSync(join(dir, 'plan.json'), plan);
      await runLauncher('gustaf-agent', env(s), ['delegate', 'plan.json'], { cwd: dir });
      assert.equal(s.seen[0].input, plan);
      await runLauncher('gustaf-agent', env(s), ['delegate', 'nope.json'], { cwd: dir });
      assert.equal('input' in s.seen[1], false);
      await runLauncher('gustaf-agent', env(s), ['list'], { cwd: dir });
      assert.equal('input' in s.seen[2], false, 'no stdin is read unless an argument asks for it');
    } finally {
      s.close();
    }
  },
);

test('errors go to stderr with a non-zero exit; setup problems name the setting', { skip: !hasSh }, async () => {
  const s = await server(() => ({ status: 422, text: 'No task "t9" in this chat.' }));
  try {
    const r = await runLauncher('gustaf-agent', env(s), ['wait', 't9']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'No task "t9" in this chat.\n');
    const none = await runLauncher('gustaf-agent', {}, ['list']);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /Subagents from CLI agents/);
    const device = await runLauncher('gustaf-device', {}, ['list']);
    assert.match(device.stderr, /Agent device access/);
  } finally {
    s.close();
  }
});
