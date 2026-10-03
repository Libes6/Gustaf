import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { shq, psq, winArg, shellFor, invocationScript, findCliScript, detectScript, cliCandidates, dirname, isWinShim } from '../src/providers/shell.ts';
import { detectPlatform } from '../src/lib/platform.ts';

const posix = process.platform !== 'win32';

test('platform detection from navigator strings', () => {
  assert.equal(detectPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macos');
  assert.equal(detectPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'windows');
  assert.equal(detectPlatform('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)'), 'linux');
  assert.equal(detectPlatform('', ''), 'linux');
});

test('shell per OS', () => {
  assert.equal(shellFor('macos').name, 'zsh');
  assert.equal(shellFor('linux').name, 'bash');
  assert.deepEqual(shellFor('linux').args('echo hi'), ['-lc', 'echo hi']);
  const ps = shellFor('windows');
  assert.equal(ps.name, 'powershell');
  assert.equal(ps.kind, 'powershell');
  assert.equal(ps.args('x').at(-2), '-Command');
  assert.ok(ps.args('x').at(-1).endsWith('x'));
});

test('shq quotes single quotes and metacharacters', () => {
  assert.equal(shq('abc'), "'abc'");
  assert.equal(shq("it's"), `'it'\\''s'`);
  assert.equal(shq('$(rm -rf /) `x` "y" \\ ; & |'), `'$(rm -rf /) \`x\` "y" \\ ; & |'`);
  assert.equal(shq(''), "''");
});

test('psq doubles single quotes, including typographic ones', () => {
  assert.equal(psq("it's"), "'it''s'");
  assert.equal(psq('a\u2019b'), "'a\u2019\u2019b'");
  assert.equal(psq('$env:PATH `n "x"'), `'$env:PATH \`n "x"'`);
});

test('winArg follows CommandLineToArgvW rules', () => {
  assert.equal(winArg('plain'), 'plain');
  assert.equal(winArg('say "hi"'), 'say \\"hi\\"');
  assert.equal(winArg('a\\"b'), 'a\\\\\\"b');
  assert.equal(winArg('C:\\dir\\'), 'C:\\dir\\');
  assert.equal(winArg('C:\\my dir\\'), 'C:\\my dir\\\\');
  assert.equal(winArg('a\\b'), 'a\\b');
});

test('paths', () => {
  assert.equal(dirname('/usr/bin/claude'), '/usr/bin');
  assert.equal(dirname('C:\\Users\\me\\claude.cmd'), 'C:\\Users\\me');
  assert.equal(dirname('claude'), '');
  assert.ok(isWinShim('C:\\x\\claude.CMD'));
  assert.ok(!isWinShim('claude.exe'));
});

test('POSIX invocation quotes every argument and the prompt', () => {
  const s = invocationScript('posix', { executable: '/opt/my tools/claude', args: ['-p', '--model', 'x'], prompt: "it's $(date)", prependExecutableDir: true, nullStdin: true });
  assert.equal(s, `export PATH='/opt/my tools':"$PATH"; exec '/opt/my tools/claude' '-p' '--model' 'x' 'it'\\''s $(date)' < /dev/null`);
  assert.equal(invocationScript('posix', { executable: 'node', args: ['/a b/s.mjs'], env: { K: "v'1" } }), `exec env K='v'\\''1' 'node' '/a b/s.mjs'`);
});

test('POSIX invocation runs in a real shell without interpreting the prompt', { skip: !posix }, () => {
  const prompt = `a "b" 'c' $HOME \`id\` ; echo injected\nline2`;
  const script = invocationScript('posix', { executable: process.execPath, args: ['-e', 'process.stdout.write(process.argv[1])'], prompt });
  assert.equal(execFileSync('/bin/sh', ['-c', script]).toString(), prompt);
});

test('PowerShell invocation: exe gets escaped args, shim gets the prompt on stdin', () => {
  const exe = invocationScript('powershell', { executable: 'C:\\bin\\claude.exe', args: ['-p'], prompt: 'say "hi" & more', nullStdin: true });
  assert.equal(exe, `$null | & 'C:\\bin\\claude.exe' '-p' 'say \\"hi\\" & more'; exit $LASTEXITCODE`);
  const shim = invocationScript('powershell', { executable: 'C:\\npm\\claude.cmd', args: ['-p'], prompt: '& calc | "x" %PATH%', prependExecutableDir: true });
  assert.ok(shim.startsWith(`$env:PATH = 'C:\\npm' + ';' + $env:PATH; `));
  assert.ok(shim.includes(`| & 'C:\\npm\\claude.cmd' '-p'; exit $LASTEXITCODE`));
  assert.ok(!shim.includes('calc'), 'prompt must not appear as text');
  const b64 = /FromBase64String\('([^']+)'\)/.exec(shim)[1];
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), '& calc | "x" %PATH%');
  const env = invocationScript('powershell', { executable: 'node', args: ["it's.mjs"], env: { MCODE_CODEX_BINARY: 'C:\\a b\\codex.cmd' } });
  assert.equal(env, `$env:MCODE_CODEX_BINARY = 'C:\\a b\\codex.cmd'; & 'node' 'it''s.mjs'; exit $LASTEXITCODE`);
});

test('CLI candidates differ per OS and drop the ChatGPT bundle outside macOS', () => {
  assert.ok(cliCandidates('macos', 'codex').some((c) => c.startsWith('/Applications/ChatGPT.app')));
  assert.ok(!cliCandidates('linux', 'codex').some((c) => c.includes('/Applications')));
  assert.ok(!cliCandidates('windows', 'codex').some((c) => c.includes('/')));
  assert.ok(cliCandidates('windows', 'claude').some((c) => c.endsWith('.cmd')));
});

test('discovery scripts', () => {
  const mac = findCliScript('macos', 'claude');
  assert.ok(mac.includes('(N)') && mac.includes('command -v \'claude\''));
  const linux = findCliScript('linux', 'claude');
  assert.ok(!linux.includes('(N)'));
  assert.ok(findCliScript('linux', 'codex', true).includes('--version'));
  const win = findCliScript('windows', 'claude');
  assert.ok(win.includes('Get-Command') && win.includes('"$env:APPDATA\\npm\\claude.cmd"'));
  assert.ok(detectScript('linux', ['codex', 'claude']).endsWith('; true'));
  assert.ok(detectScript('windows', ['codex']).includes('[char]9'));
});

test('discovery script finds an executable on PATH in a real shell', { skip: !posix }, () => {
  const script = findCliScript('linux', 'node');
  const out = execFileSync('/bin/sh', ['-c', script]).toString().trim();
  assert.ok(out.endsWith('node'));
});
