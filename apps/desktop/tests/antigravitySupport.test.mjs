// Pure helpers of the Antigravity integration (providers/antigravitySupport.ts): the sign-in link check, launch
// script and environment, settings, models. The link shapes follow T3 Code's parser (MIT); synthetic, not recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const S = await import('../src/providers/antigravitySupport.ts');

const good =
  'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=abc123&scope=openid';

test('only a Google loopback-redirect authorization link is accepted', () => {
  assert.equal(S.parseAuthorizationUrl(good), good);
  const bad = [
    'http://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=a',
    good.replace('accounts.google.com', 'accounts.google.com.evil.example'),
    good.replace('accounts.google.com', 'user:pw@accounts.google.com'),
    good.replace('/o/oauth2/v2/auth', '/signin'),
    good.replace('response_type=code', 'response_type=token'),
    good.replace('127.0.0.1%3A51234', 'evil.example%3A51234'),
    good.replace('51234', '80'),
    good.replace('&state=abc123', ''),
    good + '&state=second',
    good + '#frag',
    'javascript:alert(1)',
    'file:///etc/passwd',
    good + ' extra',
    'x'.repeat(20000),
    '',
  ];
  for (const b of bad) assert.equal(S.parseAuthorizationUrl(b), null, b.slice(0, 80));
});

test('the link is found on the agent line and on the BROWSER helper line only', () => {
  assert.equal(S.authUrlFromLine(S.AUTH_PREFIX + good), good);
  assert.equal(S.authUrlFromLine(S.BROWSER_MARKER + good + '\r'), good);
  assert.equal(S.authUrlFromLine('some banner ' + good), null);
  assert.equal(S.authUrlFromLine(S.AUTH_PREFIX + 'https://evil.example/'), null);
});

test('line splitter keeps partial lines and drops an endless one', () => {
  const lines = [];
  const feed = S.lineSplitter((l) => lines.push(l), 20);
  feed('abc\nde');
  feed('f\nghi');
  assert.deepEqual(lines, ['abc', 'def']);
  feed('x'.repeat(50)); // 'ghi' + 50 x is longer than the limit: dropped
  feed('\nok\n');
  assert.deepEqual(lines, ['abc', 'def', '', 'ok']);
});

test('launch environment: credential of the selected method only, private home, no secret in the script', () => {
  const key = 'AIza-SECRET-KEY-0001';
  const env = S.launchEnv({
    geminiHome: '/p/home',
    tempDir: '/p/tmp',
    method: 'gemini-api-key',
    apiKey: key,
    platform: 'macos',
  });
  assert.equal(env.GEMINI_API_KEY, key);
  assert.equal(env.GEMINI_HOME, '/p/home');
  assert.equal(env.TMPDIR, '/p/tmp');
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, '1');
  assert.ok(!env.BROWSER.includes(':') && !env.BROWSER.includes(';'), 'BROWSER must not contain ":" or ";"');
  const vertex = S.launchEnv({
    geminiHome: 'h',
    tempDir: 't',
    method: 'agent-platform',
    apiKey: key,
    platform: 'linux',
  });
  assert.equal(vertex.GOOGLE_API_KEY, key);
  assert.equal(vertex.GEMINI_API_KEY, undefined);
  const personal = S.launchEnv({
    geminiHome: 'h',
    tempDir: 't',
    method: 'oauth-personal',
    apiKey: key,
    platform: 'macos',
  });
  assert.equal(personal.GEMINI_API_KEY, undefined);
  assert.equal(personal.GOOGLE_API_KEY, undefined);
  const win = S.launchEnv({ geminiHome: 'h', tempDir: 't', method: 'oauth-personal', platform: 'windows' });
  assert.equal(win.TEMP, 't');
  assert.equal(win.BROWSER, undefined);
  for (const kind of ['posix', 'powershell']) {
    const script = S.launchScript(kind, undefined);
    assert.ok(!script.includes(key));
    assert.ok(script.includes('GEMINI_API_KEY'), 'ambient credentials are scrubbed');
  }
});

test('launch script: configured binary is quoted and exec-ed; blank looks on PATH (both registry names)', () => {
  const s = S.launchScript('posix', "/Users/me/my apps/agy's/agy_acp_server");
  assert.match(s, /exec '\/Users\/me\/my apps\/agy'\\''s\/agy_acp_server'$/);
  const path = S.launchScript('posix', '');
  assert.match(path, /command -v agy_acp_server \|\| command -v agy_acp_server\.par/);
  assert.match(path, /exit 127/);
  assert.match(S.launchScript('powershell', 'C:\\agy\\agy_acp_server.exe'), /& 'C:\\agy\\agy_acp_server\.exe'; exit/);
  assert.equal(S.validBinary('/ok/path'), true);
  assert.equal(S.validBinary('/bad\npath'), false);
  assert.equal(S.validBinary(undefined), true);
});

test('settings are normalized; config issues name what is missing; profile settings hold no credential', () => {
  assert.deepEqual(S.normalizeSettings({ method: 'nope', binary: '  ' }), { method: 'oauth-personal' });
  assert.deepEqual(S.normalizeSettings({ method: 'oauth-business', project: ' p ', location: 'eu' }), {
    method: 'oauth-business',
    project: 'p',
    location: 'eu',
  });
  assert.equal(S.configIssue({ method: 'oauth-personal' }, false), null);
  assert.equal(S.configIssue({ method: 'oauth-business' }, false), 'project');
  assert.equal(S.configIssue({ method: 'oauth-business', project: 'p', location: 'l' }, false), null);
  assert.equal(S.configIssue({ method: 'gemini-api-key' }, false), 'apiKey');
  assert.equal(S.configIssue({ method: 'gemini-api-key' }, true), null);
  assert.equal(S.configIssue({ method: 'agent-platform' }, false), 'apiKeyOrProject');
  assert.equal(S.configIssue({ method: 'agent-platform', project: 'p', location: 'l' }, false), null);
  assert.deepEqual(JSON.parse(S.profileSettingsJson({ method: 'agent-platform', project: 'p', location: 'l' })), {
    auth: { type: 'agent-platform' },
    gcp: { project: 'p', location: 'l' },
  });
  assert.deepEqual(JSON.parse(S.profileSettingsJson({ method: 'oauth-personal' })), {
    auth: { type: 'oauth-personal' },
  });
  assert.equal(S.usesBrowser('oauth-business'), true);
  assert.equal(S.usesBrowser('gemini-api-key'), false);
});

test('models and reasoning levels come from the session config options', () => {
  const setup = {
    configOptions: [
      {
        id: 'model',
        category: 'model',
        name: 'M',
        currentValue: 'a',
        options: [
          { value: 'a', name: 'Alpha' },
          { value: 'b', name: '' },
          { value: 'default', name: 'dup' },
        ],
      },
      {
        id: 't',
        category: 'thought_level',
        name: 'T',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'x1', name: 'High' },
          { value: 'weird', name: 'Weird' },
        ],
      },
    ],
  };
  const models = S.modelsFromSession(setup, 'p1');
  assert.deepEqual(
    models.map((m) => [m.id, m.name, m.providerId]),
    [
      ['default', 'Default', 'p1'],
      ['a', 'Alpha', 'p1'],
      ['b', 'b', 'p1'],
    ],
  );
  assert.deepEqual(S.thoughtLevels(setup.configOptions), { low: 'low', high: 'x1' });
  const legacy = S.modelsFromSession(
    { configOptions: [], models: { current: 'm', available: [{ id: 'm', name: 'M' }] } },
    'p',
  );
  assert.deepEqual(
    legacy.map((m) => m.id),
    ['default', 'm'],
  );
  assert.equal(S.safeMessage(new Error('bad key abcd1234 here'), ['abcd1234']), 'bad key *** here');
});

test('binary resolution: an explicit path wins, then the managed runtime, then PATH', () => {
  assert.equal(S.effectiveBinary('/opt/agy', '/data/rt/agy'), '/opt/agy');
  assert.equal(S.effectiveBinary('  /opt/agy  ', undefined), '/opt/agy');
  assert.equal(S.effectiveBinary('', '/data/rt/agy'), '/data/rt/agy');
  assert.equal(S.effectiveBinary(undefined, '/data/rt/agy'), '/data/rt/agy');
  assert.equal(S.effectiveBinary('   ', undefined), undefined);
  assert.equal(S.effectiveBinary(undefined, undefined), undefined);
  // an unset binary falls back to PATH in the launch script, a set one is exec'ed directly
  assert.match(S.launchScript('posix', S.effectiveBinary(undefined, undefined)), /command -v agy_acp_server/);
  assert.match(
    S.launchScript('posix', S.effectiveBinary('', '/data/rt/agy_acp_server.par')),
    /exec .*agy_acp_server\.par/,
  );
});

test('formatMb', () => {
  assert.equal(S.formatMb(111_456_962), '111');
  assert.equal(S.formatMb(50_000_000), '50.0');
  assert.equal(S.formatMb(0), '0.0');
});
