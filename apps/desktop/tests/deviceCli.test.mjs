// The `gustaf-device` command for CLI agents: argv parsing (src/agent/deviceCli.ts) and the real launcher script
// (src-tauri/src/device_bridge/gustaf-device.sh) against a local HTTP server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const cli = await import('../src/agent/deviceCli.ts');
const { parseDeviceCall, DEVICE_TOOL_NAMES } = await import('../src/agent/deviceCore.ts');

const ok = (...argv) => {
  const r = cli.parseDeviceArgv(argv);
  assert.equal(r.ok, true, `${argv.join(' ')}: ${r.error}`);
  return r;
};
const bad = (re, ...argv) => {
  const r = cli.parseDeviceArgv(argv);
  assert.equal(r.ok, false, argv.join(' '));
  assert.match(r.error, re);
};

test('every command maps to a tool and passes the same validation as the API tools', () => {
  assert.deepEqual(ok('list'), { ok: true, tool: 'device_list', args: {} });
  assert.deepEqual(ok('open', '--device', 'iPhone 17 Pro'), {
    ok: true,
    tool: 'device_open',
    args: { device: 'iPhone 17 Pro' },
  });
  assert.deepEqual(ok('--device=SIM-1', 'snapshot', '--screenshot').args, { device: 'SIM-1', screenshot: true });
  assert.deepEqual(ok('tap', '@e7').args, { ref: '@e7' });
  assert.deepEqual(ok('tap', '120', '300.5').args, { x: 120, y: 300.5 });
  assert.deepEqual(ok('long-press', '@e7', '--ms', '900').args, { ref: '@e7', ms: 900 });
  assert.deepEqual(ok('swipe', '200', '600', '200', '200', '--ms=300').args, {
    from_x: 200,
    from_y: 600,
    to_x: 200,
    to_y: 200,
    ms: 300,
  });
  assert.deepEqual(ok('type', 'hello', 'world').args, { text: 'hello world' });
  assert.deepEqual(ok('type', '--', '-5 apples').args, { text: '-5 apples' });
  assert.deepEqual(ok('fill', '@e19', 'wifi settings').args, { ref: '@e19', text: 'wifi settings' });
  assert.deepEqual(ok('fill', '10', '20', 'x').args, { x: 10, y: 20, text: 'x' });
  assert.deepEqual(ok('fill', '@e19').args, { ref: '@e19', text: '' });
  assert.deepEqual(ok('press', 'home').args, { key: 'home' });
  assert.deepEqual(ok('scroll', 'down', '--amount', '0.5').args, { direction: 'down', amount: 0.5 });
  assert.deepEqual(ok('open-app', 'com.apple.Preferences').args, { app: 'com.apple.Preferences' });
  assert.deepEqual(ok('close', '--shutdown').args, { shutdown: true });
  for (const argv of [['tap', '@e1'], ['press', 'back'], ['close']]) {
    const r = ok(...argv);
    assert.equal(parseDeviceCall(r.tool, r.args).ok, true);
  }
  // Each tool has a command.
  const tools = new Set(
    [
      'list',
      'open',
      'snapshot',
      'tap',
      'long-press',
      'swipe',
      'type',
      'fill',
      'press',
      'scroll',
      'open-app',
      'close',
    ].map(
      (c) =>
        ok(
          ...(c === 'tap' || c === 'long-press'
            ? [c, '@e1']
            : c === 'swipe'
              ? [c, '1', '1', '2', '2']
              : c === 'type'
                ? [c, 'x']
                : c === 'fill'
                  ? [c, '@e1', 'x']
                  : c === 'press'
                    ? [c, 'home']
                    : c === 'scroll'
                      ? [c, 'up']
                      : c === 'open-app'
                        ? [c, 'Maps']
                        : [c]),
        ).tool,
    ),
  );
  assert.deepEqual([...tools].sort(), [...DEVICE_TOOL_NAMES].sort());
});

test('parse errors say what is wrong', () => {
  bad(/No command/);
  bad(/Unknown command "tapp"/, 'tapp');
  bad(/Unknown option --force/, 'tap', '@e1', '--force');
  bad(/--device needs a value/, 'list', '--device');
  bad(/needs an @ref or x y/, 'tap');
  bad(/needs an @ref or x y/, 'tap', '5');
  bad(/swipe needs/, 'swipe', '1', '2');
  bad(/text/, 'type');
  bad(/one of/, 'press', 'power');
  bad(/one of/, 'scroll', 'sideways');
  bad(/Unexpected argument "extra"/, 'snapshot', 'extra');
  bad(/--ms does not apply/, 'tap', '@e1', '--ms', '100');
  bad(/--shutdown only applies to close/, 'list', '--shutdown');
  bad(/between 50 and 10000/, 'long-press', '@e1', '--ms', '5');
  bad(/outside|between 0/, 'tap', '-5', '10');
  bad(/ref "e1;rm" is not an element ref|not an element ref/, 'tap', 'e1;rm');
  bad(/option/, 'open-app', '--', '-h');
});

test('the error output includes the usage', () => {
  const t = cli.cliErrorText('No command given.');
  assert.match(t, /^gustaf-device: No command given\.\n\nUsage: gustaf-device/);
  for (const c of ['list', 'snapshot', 'tap', 'swipe', 'fill', 'open-app', 'close'])
    assert.match(t, new RegExp(`\\n  ${c}`));
});

test('the prompt paragraph names the command and the verify-and-resnapshot rules', () => {
  assert.match(cli.DEVICE_CLI_PROMPT, /gustaf-device list/);
  assert.match(cli.DEVICE_CLI_PROMPT, /snapshot/);
  assert.match(cli.DEVICE_CLI_PROMPT, /untrusted data/);
});

// ---- the launcher script ----

const script = fileURLToPath(new URL('../src-tauri/src/device_bridge/gustaf-device.sh', import.meta.url));
const hasSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v curl']).status === 0;

/** A server that records requests and answers with `reply`. */
async function server(reply) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        args: new URLSearchParams(body).getAll('a'),
      });
      const r = reply(seen.at(-1));
      res.writeHead(r.status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(r.text);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${srv.address().port}/v1/device`, close: () => srv.close() };
}
const runShim = (env, ...args) =>
  new Promise((resolve) => {
    const p = spawn('sh', [script, ...args], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });

test('the launcher sends the arguments in order and prints the answer', { skip: !hasSh }, async () => {
  const s = await server(() => ({ status: 200, text: 'Tapped @e7 (201, 355)\nNo visible change on screen.' }));
  try {
    const r = await runShim(
      { GUSTAF_DEVICE_URL: s.url, GUSTAF_DEVICE_TOKEN: 'tok' },
      'fill',
      '@e19',
      'héllo & 100% $HOME \'q\' "d"\nline2',
      '-x',
    );
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'Tapped @e7 (201, 355)\nNo visible change on screen.\n');
    assert.deepEqual(s.seen, [
      {
        method: 'POST',
        url: '/v1/device',
        auth: 'Bearer tok',
        args: ['fill', '@e19', 'héllo & 100% $HOME \'q\' "d"\nline2', '-x'],
      },
    ]);
  } finally {
    s.close();
  }
});

test('the launcher exits non-zero and prints errors to stderr', { skip: !hasSh }, async () => {
  const s = await server(() => ({ status: 422, text: 'That element ref is no longer valid.' }));
  try {
    const r = await runShim({ GUSTAF_DEVICE_URL: s.url, GUSTAF_DEVICE_TOKEN: 'tok' }, 'tap', '@e9');
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'That element ref is no longer valid.\n');
  } finally {
    s.close();
  }
});

test(
  'the launcher explains itself without the environment, and when the app is unreachable',
  { skip: !hasSh },
  async () => {
    const none = await runShim({}, 'list');
    assert.equal(none.code, 2);
    assert.match(none.stderr, /Agent device access/);
    const s = await server(() => ({ status: 200, text: '' }));
    const url = s.url;
    s.close();
    const down = await runShim({ GUSTAF_DEVICE_URL: url, GUSTAF_DEVICE_TOKEN: 'tok' }, 'list');
    assert.equal(down.code, 3);
    assert.match(down.stderr, /cannot reach Gustaf/);
  },
);

// ---- how the agent processes are started ----

test('the launcher folder goes first on PATH and the bridge variables are set for the agent process', async () => {
  const { invocationScript } = await import('../src/providers/shell.ts');
  const s = invocationScript('posix', {
    executable: '/usr/local/bin/claude',
    args: ['-p'],
    env: { GUSTAF_DEVICE_URL: 'http://127.0.0.1:5/v1/device', GUSTAF_DEVICE_TOKEN: 't' },
    prependPath: "/data/it's/bin",
    nullStdin: true,
  });
  assert.equal(
    s,
    `export PATH='/data/it'\\''s/bin':"$PATH"; exec env GUSTAF_DEVICE_URL='http://127.0.0.1:5/v1/device' GUSTAF_DEVICE_TOKEN='t' '/usr/local/bin/claude' '-p' < /dev/null`,
  );
  assert.equal(invocationScript('posix', { executable: '/x/codex', args: ['exec'] }), "exec '/x/codex' 'exec'");
});

test('Claude Code may run gustaf-device without a prompt, but not in read-only modes', async () => {
  const { claudeArgs } = await import('../src/providers/claudeCli.ts');
  const flag = '--allowedTools=Bash(gustaf-device:*)';
  assert.equal(claudeArgs({ access: 'auto', deviceCommand: true }).includes(flag), true);
  assert.equal(claudeArgs({ access: 'auto' }).includes(flag), false);
  assert.equal(claudeArgs({ access: 'readonly', deviceCommand: true }).includes(flag), false);
  assert.equal(claudeArgs({ access: 'auto', mode: 'plan', deviceCommand: true }).includes(flag), false);
});

test('a device setting saved after the first load is seen by the next load', async () => {
  const store = await import('../src/agent/deviceSettingsStore.ts');
  store.resetDeviceSettings();
  assert.equal((await store.loadDeviceSettings()).access, false);
  store.saveDeviceSettings({ access: true, askFirst: false });
  assert.deepEqual(await store.loadDeviceSettings(), { access: true, askFirst: false });
  store.resetDeviceSettings();
});
