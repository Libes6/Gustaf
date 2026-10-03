import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MD_LABELS, EXPORT_FORMAT, EXPORT_VERSION, IMAGE_OMITTED, ImportError, MD_BLOCK_LIMIT, REDACTED,
  buildBundle, exportFileName, formatDate, importBundle, parseBundle, redactSecrets, redactValue, toJson, toMarkdown,
} from '../src/lib/exportChats.ts';

const NOW = Date.UTC(2026, 9, 2, 12, 30, 15);
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

const chat = (over = {}) => ({ title: 'Fix login', created_at: T0, updated_at: T0 + 60_000, archived: 0, ...over });
const text = (t) => ({ type: 'text', text: t });
const msg = (role, parts, extra = {}) => ({ role, parts, ...extra });

/** A realistic chat: user text, assistant tool calls, tool results, a native activity and a Computer Use action. */
function sampleSource() {
  return {
    chat: chat(),
    project: { name: 'web-app', path: '/Users/me/web-app' },
    messages: [
      msg('user', [text('Please fix the login bug')], { id: 1, chat_id: 1, created_at: T0, meta: { checkpoint: 'cp-1' } }),
      msg('assistant', [
        text('Looking at the code.'),
        { type: 'tool_call', id: 'call_1', name: 'run_command', args: { command: 'npm test' } },
        { type: 'tool_call', id: 'call_2', name: 'edit_file', args: { path: 'src/login.ts', old_string: 'a\nb', new_string: 'a\nc' } },
      ], {
        id: 2, chat_id: 1, created_at: T0 + 1000,
        meta: { provider: 'openai', model: 'gpt-5', responseId: 'resp_123', durationMs: 1200, usage: { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 1 } },
      }),
      msg('tool', [
        { type: 'tool_result', id: 'call_1', name: 'run_command', output: '1 failing', isError: true },
        { type: 'tool_result', id: 'call_2', name: 'edit_file', output: 'ok' },
      ], { id: 3, chat_id: 1, created_at: T0 + 2000 }),
      msg('assistant', [
        { type: 'activity', id: 'act_1', name: 'bash', args: { command: 'ls' }, status: 'success', output: 'a.txt' },
        { type: 'tool_call', id: 'cu_1', name: 'computer', args: {}, computer: { actions: [{ type: 'click', x: 10, y: 20 }, { type: 'type', text: 'hello' }, { type: 'keypress', keys: ['cmd', 'l'] }] } },
        text('Done.'),
      ], { id: 4, chat_id: 1, created_at: T0 + 3000, meta: { compacted: true } }),
    ],
  };
}

function memoryStore(existing = []) {
  const db = { chats: [...existing], messages: [], projects: [], stamps: [], discarded: [], failOn: null };
  return {
    db,
    existing: async () => db.chats.map(({ title, created_at }) => ({ title, created_at })),
    project: async (name, path) => (db.projects.push({ name, path }), db.projects.length),
    createChat: async (projectId, title) => (db.chats.push({ id: db.chats.length + 1, projectId, title, created_at: Date.now() }), db.chats.length),
    addMessage: async (chatId, m) => {
      if (db.failOn === db.messages.length) throw new Error('disk full');
      db.messages.push({ chatId, ...JSON.parse(JSON.stringify(m)) });
      return db.messages.length;
    },
    stamp: async (chatId, c, messages) => {
      db.stamps.push({ chatId, ...c, messages });
      db.chats[chatId - 1].created_at = c.createdAt ?? db.chats[chatId - 1].created_at;
    },
    discard: async (chatId) => { db.discarded.push(chatId); },
  };
}

test('JSON export is versioned and drops machine-local metadata', () => {
  const bundle = buildBundle([sampleSource()], { now: NOW });
  assert.equal(bundle.format, EXPORT_FORMAT);
  assert.equal(bundle.version, EXPORT_VERSION);
  assert.equal(bundle.exportedAt, '2026-10-02T12:30:15.000Z');
  const [c] = bundle.chats;
  assert.deepEqual(c.project, { name: 'web-app', path: '/Users/me/web-app' });
  assert.equal(c.archived, false);
  assert.equal(c.createdAt, T0);
  assert.equal(c.messages[0].meta, undefined, 'checkpoint ids are not exported');
  assert.equal(c.messages[1].meta.responseId, undefined, 'provider response ids are not exported');
  assert.deepEqual(c.messages[1].meta, { provider: 'openai', model: 'gpt-5', durationMs: 1200, usage: { input: 10, output: 5, cached: 0, cacheWrite: 0, reasoning: 1 } });
  assert.equal(c.messages[0].createdAt, T0);
  assert.ok(!toJson(bundle).includes('chat_id'));
});

test('JSON round trip through parse and import restores messages, timestamps and projects', async () => {
  const bundle = buildBundle([sampleSource(), { chat: chat({ title: 'Old', archived: 1, created_at: T0 - 5000 }), project: null, messages: [msg('user', [text('hi')], { created_at: T0 - 5000 })] }], { now: NOW });
  const parsed = parseBundle(toJson(bundle));
  assert.deepEqual(parsed, bundle);

  const store = memoryStore();
  const progress = [];
  const result = await importBundle(parsed, store, (d, n) => progress.push([d, n]));
  assert.deepEqual(result, { imported: 2, skipped: 0, messages: 5 });
  assert.deepEqual(progress.at(-1), [2, 2]);
  assert.deepEqual(store.db.projects, [{ name: 'web-app', path: '/Users/me/web-app' }]);
  assert.equal(store.db.chats[0].projectId, 1);
  assert.equal(store.db.chats[1].projectId, null);
  // Every stored message is exactly what was exported.
  assert.deepEqual(store.db.messages.slice(0, 4).map(({ chatId, ...m }) => m), bundle.chats[0].messages.map(({ createdAt, ...m }) => m));
  assert.equal(store.db.stamps[0].createdAt, T0);
  assert.equal(store.db.stamps[1].archived, true);
  assert.deepEqual(store.db.stamps[0].messages.map((m) => m.createdAt), [T0, T0 + 1000, T0 + 2000, T0 + 3000]);
});

test('importing the same export twice skips chats that already exist', async () => {
  const parsed = parseBundle(toJson(buildBundle([sampleSource()], { now: NOW })));
  const store = memoryStore();
  assert.equal((await importBundle(parsed, store)).imported, 1);
  const again = await importBundle(parsed, store);
  assert.deepEqual(again, { imported: 0, skipped: 1, messages: 0 });
  assert.equal(store.db.chats.length, 1);
  // Duplicates inside one file are skipped too.
  const dup = { ...parsed, chats: [parsed.chats[0], parsed.chats[0]] };
  assert.deepEqual(await importBundle(dup, memoryStore()), { imported: 1, skipped: 1, messages: 4 });
});

test('a failure while inserting messages discards the half-imported chat', async () => {
  const parsed = parseBundle(toJson(buildBundle([sampleSource()], { now: NOW })));
  const store = memoryStore();
  store.db.failOn = 2;
  await assert.rejects(importBundle(parsed, store), /disk full/);
  assert.deepEqual(store.db.discarded, [1]);
});

test('Markdown snapshot for a chat with tool calls', () => {
  const md = toMarkdown(buildBundle([sampleSource()], { now: NOW }));
  const expected = `# Fix login

*Exported from M Code on 2026-10-02 12:30 UTC*

- Project: web-app (/Users/me/web-app)
- Created: 2026-01-05 09:00 UTC
- Updated: 2026-01-05 09:01 UTC
- Messages: 4

## User

Please fix the login bug

## Assistant (gpt-5)

Looking at the code.

**Tool call: \`run_command\`**

\`\`\`sh
npm test
\`\`\`

**Tool call: \`edit_file\`**

\`src/login.ts\`

\`\`\`diff
- a
- b
+ a
+ c
\`\`\`

**Tool result: \`run_command\`** (Failed)

\`\`\`text
1 failing
\`\`\`

**Tool result: \`edit_file\`**

\`\`\`text
ok
\`\`\`

## Assistant

**Tool call: \`bash\`** (Completed)

\`\`\`sh
ls
\`\`\`

\`\`\`text
a.txt
\`\`\`

**Tool call: \`computer\`**

- click 10,20
- type "hello"
- keypress cmd+l

Done.
`;
  assert.equal(md, expected);
});

test('Markdown for several chats has one section per chat and localizable labels', () => {
  const ru = { ...DEFAULT_MD_LABELS, user: 'Пользователь', assistant: 'Ассистент', exported: 'Экспорт из M Code, {date}', chats: 'Чатов', messages: 'Сообщений' };
  const bundle = buildBundle([
    { chat: chat({ title: 'Первый чат' }), project: null, messages: [msg('user', [text('Привет')]), msg('assistant', [text('Здравствуйте')])] },
    { chat: chat({ title: 'Second', created_at: 0, updated_at: 0 }), project: null, messages: [msg('user', [text('Hello')])] },
  ], { now: NOW });
  const md = toMarkdown(bundle, ru);
  assert.equal(md, `# M Code

*Экспорт из M Code, 2026-10-02 12:30 UTC*

- Чатов: 2

---

## Первый чат

- Created: 2026-01-05 09:00 UTC
- Updated: 2026-01-05 09:01 UTC
- Сообщений: 2

### Пользователь

Привет

### Ассистент

Здравствуйте

---

## Second

- Сообщений: 1

### Пользователь

Hello
`);
});

test('tool cards: write_file, generic JSON, native error, empty output and computer calls read well', () => {
  const md = toMarkdown(buildBundle([{
    chat: chat(), project: null,
    messages: [
      msg('assistant', [
        { type: 'tool_call', id: '1', name: 'write_file', args: { path: 'a.txt', content: 'hello' } },
        { type: 'tool_call', id: '2', name: 'search', args: { pattern: 'foo', glob: '*.ts' } },
        { type: 'tool_call', id: '3', name: 'run_command', args: { command: 'sleep 1', timeout_ms: 500 } },
        { type: 'activity', id: '4', name: 'shell', args: { command: 'false' }, status: 'error', output: 'exit 1' },
        { type: 'activity', id: '5', name: 'shell', args: {}, status: 'running' },
      ]),
      msg('tool', [{ type: 'tool_result', id: '2', name: 'search', output: '' }]),
    ],
  }], { now: NOW }));
  assert.match(md, /`a\.txt`\n\n```\nhello\n```/);
  assert.match(md, /\*\*Tool call: `search`\*\*\n\n```json\n\{\n {2}"pattern": "foo",\n {2}"glob": "\*\.ts"\n\}\n```/);
  assert.match(md, /```sh\nsleep 1\n```\n\n```json\n\{\n {2}"timeout_ms": 500\n\}\n```/);
  assert.match(md, /\*\*Tool call: `shell`\*\* \(Failed\)\n\n```sh\nfalse\n```\n\n```text\nexit 1\n```/);
  assert.match(md, /\*\*Tool call: `shell`\*\* \(Running\)\n\n\*\*Tool result: `search`/);
  assert.match(md, /\*\*Tool result: `search`\*\*\n\n\*\(no output\)\*/);
});

test('long outputs are clipped in Markdown but kept in JSON; fences cannot be broken by content', () => {
  const output = 'x'.repeat(MD_BLOCK_LIMIT + 50);
  const bundle = buildBundle([{
    chat: chat(), project: null,
    messages: [
      msg('tool', [{ type: 'tool_result', id: '1', name: 'run_command', output }]),
      msg('tool', [{ type: 'tool_result', id: '2', name: 'run_command', output: 'before\n```js\ncode\n```\nafter' }]),
      msg('assistant', [text('unclosed:\n```js\nconst a = 1;')]),
      msg('assistant', [text('next message')]),
    ],
  }], { now: NOW });
  const md = toMarkdown(bundle);
  assert.ok(md.includes('x'.repeat(MD_BLOCK_LIMIT) + '\n… 50 more characters not shown'));
  assert.ok(!md.includes('x'.repeat(MD_BLOCK_LIMIT + 1)));
  assert.ok(md.includes('````text\nbefore\n```js\ncode\n```\nafter\n````'), 'inner fences get a longer outer fence');
  assert.ok(md.includes('```js\nconst a = 1;\n```\n\n## Assistant\n\nnext message'), 'an unclosed fence is closed');
  assert.equal(bundle.chats[0].messages[0].parts[0].output, output);
});

test('unicode survives JSON and Markdown unchanged and clipping never splits a surrogate pair', async () => {
  const sample = 'Привет, мир! 你好 \u{1F600}\u{1F468}‍\u{1F469}‍\u{1F467} é שלום ‮abc‬ "quotes" \\ \t\u0000 end';
  const bundle = buildBundle([{
    chat: chat({ title: 'Заметки \u{1F4DD} 日本語' }), project: { name: 'проект', path: null },
    messages: [msg('user', [text(sample)]), msg('assistant', [text(sample)], { meta: { model: 'модель-1' } })],
  }], { now: NOW });
  const parsed = parseBundle(toJson(bundle));
  assert.deepEqual(parsed, bundle);
  assert.equal(parsed.chats[0].messages[0].parts[0].text, sample);
  assert.equal(parsed.chats[0].title, 'Заметки \u{1F4DD} 日本語');
  const md = toMarkdown(bundle);
  assert.ok(md.startsWith('# Заметки \u{1F4DD} 日本語\n'));
  assert.ok(md.includes(sample));
  assert.ok(md.includes('## Assistant (модель-1)'));

  const tail = '\u{1F600}'.repeat(MD_BLOCK_LIMIT);
  const clipped = toMarkdown(buildBundle([{ chat: chat(), project: null, messages: [msg('tool', [{ type: 'tool_result', id: '1', name: 't', output: tail }])] }], { now: NOW }));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(clipped), 'no lone surrogates');

  const store = memoryStore();
  await importBundle(parsed, store);
  assert.equal(store.db.messages[0].parts[0].text, sample);
});

test('file names are safe for the save dialog', () => {
  assert.equal(exportFileName('markdown', ['Fix login/bug: now?'], NOW), 'Fix-login-bug-now.md');
  assert.equal(exportFileName('json', ['Заметки про код'], NOW), 'Заметки-про-код.json');
  assert.equal(exportFileName('json', ['...'], NOW), 'chat.json');
  assert.equal(exportFileName('markdown', ['a', 'b'], NOW), 'mcode-chats-2026-10-02.md');
  assert.equal(Array.from(exportFileName('json', ['\u{1F600}'.repeat(100)], NOW)).length, 60 + '.json'.length);
  assert.equal(formatDate('not a date'), '');
});

test('API keys and secrets are never exported', () => {
  const keys = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-1234567890-abcdefghijkl',
    'AKIAABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv',
    'hunter2-secret-pass',
  ];
  const source = {
    chat: chat({ title: `title ${keys[0]}` }), project: null,
    messages: [
      msg('user', [text(`my key is ${keys[1]} and OPENAI_API_KEY=${keys[2]}`)]),
      msg('assistant', [
        { type: 'tool_call', id: '1', name: 'run_command', args: { command: `curl -H "Authorization: Bearer ${keys[3]}" https://x`, env: { API_KEY: keys[4], password: keys[7] }, headers: { Authorization: 'Basic dXNlcjpwYXNz' } } },
      ], { meta: { provider: 'openai', model: 'gpt-5' } }),
      msg('tool', [{ type: 'tool_result', id: '1', name: 'run_command', output: `.env:\nANTHROPIC_API_KEY=${keys[0]}\nAWS=${keys[5]}\njwt=${keys[6]}\nDATABASE_URL=postgres://admin:${keys[7]}@db:5432/app` }]),
    ],
  };
  const bundle = buildBundle([source], { now: NOW });
  const json = toJson(bundle);
  const md = toMarkdown(bundle);
  for (const k of keys) {
    assert.ok(!json.includes(k), `JSON leaks ${k}`);
    assert.ok(!md.includes(k), `Markdown leaks ${k}`);
  }
  assert.ok(!json.includes('dXNlcjpwYXNz'));
  assert.ok(json.includes(REDACTED));
  assert.ok(md.includes('postgres://admin:[REDACTED]@db:5432/app'));
  assert.ok(md.includes('Authorization: Bearer [REDACTED]'));
  assert.ok(md.includes('"password": "[REDACTED]"'));
});

test('redaction keeps ordinary code and numbers intact', () => {
  for (const ok of [
    'const maxTokens = 4096; max_tokens: 100000 total_tokens: 1234567',
    'password: string;\ntoken: number',
    'const token = getToken();',
    'password=${PASSWORD} api_key=$KEY secret: <your-secret>',
    'Use a bearer token in the header',
    'sk-short',
  ]) assert.equal(redactSecrets(ok), ok);
  assert.equal(redactSecrets('password = hunter22'), `password = ${REDACTED}`);
  assert.equal(redactSecrets(`"apiKey": "abcdef123456"`), `"apiKey": "${REDACTED}"`);
  assert.equal(redactSecrets(`Authorization: ${REDACTED}`), `Authorization: ${REDACTED}`);
  assert.deepEqual(redactValue({ a: [{ accessToken: 'abc', max_tokens: 5, n: 1, note: 'ok' }], __proto__x: 1 }), { a: [{ accessToken: REDACTED, max_tokens: 5, n: 1, note: 'ok' }], __proto__x: 1 });
  const nested = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}');
  assert.equal(redactValue(nested).polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('images are omitted unless requested and computer screenshots stay out of the default export', async () => {
  const source = {
    chat: chat(), project: null,
    messages: [
      msg('user', [text('look'), { type: 'image', data: 'AAAA' }]),
      msg('tool', [{ type: 'tool_result', id: '1', name: 'computer', output: 'shot', image: 'BBBB', computer: true }]),
    ],
  };
  const plain = buildBundle([source], { now: NOW });
  assert.deepEqual(plain.chats[0].messages[0].parts, [text('look'), text(IMAGE_OMITTED)]);
  assert.equal(plain.chats[0].messages[1].parts[0].image, undefined);
  assert.equal(plain.chats[0].messages[1].parts[0].computer, true);
  assert.ok(!toJson(plain).includes('BBBB'));

  const full = buildBundle([source], { now: NOW, includeImages: true });
  assert.deepEqual(full.chats[0].messages[0].parts[1], { type: 'image', data: 'AAAA' });
  assert.equal(full.chats[0].messages[1].parts[0].image, 'BBBB');
  assert.deepEqual(parseBundle(toJson(full)), full);
  assert.ok(toMarkdown(full).includes('![image](data:image/png;base64,AAAA)'));
  assert.ok(toMarkdown(full).includes('![screenshot](data:image/png;base64,BBBB)'));
  assert.ok(toMarkdown(plain).includes(IMAGE_OMITTED));
});

test('import rejects foreign or newer files and sanitizes unknown fields', () => {
  const code = (input) => { try { parseBundle(input); } catch (e) { assert.ok(e instanceof ImportError); return e.code; } return 'ok'; };
  assert.equal(code('not json'), 'invalid_json');
  assert.equal(code('[]'), 'not_export');
  assert.equal(code(JSON.stringify({ chats: [] })), 'not_export');
  assert.equal(code(JSON.stringify({ format: 'chatgpt', version: 1, chats: [] })), 'not_export');
  assert.equal(code(JSON.stringify({ format: EXPORT_FORMAT, version: 'one', chats: [] })), 'not_export');
  assert.equal(code(JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION + 1, chats: [] })), 'unsupported_version');
  assert.equal(code(JSON.stringify({ format: EXPORT_FORMAT, version: 1, chats: [] })), 'empty');
  assert.equal(code(JSON.stringify({ format: EXPORT_FORMAT, version: 1, chats: [{ title: 'x', messages: [{ role: 'system', parts: [text('a')] }, { role: 'user', parts: [] }] }] })), 'empty');

  const parsed = parseBundle('﻿' + JSON.stringify({
    format: EXPORT_FORMAT, version: 1, extra: 'ignored',
    chats: [{
      title: '  ', createdAt: -5, updatedAt: 'x', archived: 'yes', project: { name: ' ', path: 5 }, secret: 'drop me',
      messages: [
        { role: 'assistant', createdAt: T0, evil: 1, parts: [text('ok'), { type: 'unknown' }, { type: 'text', text: 5 }, { type: 'tool_call', id: 'c', name: 'n', args: { a: 1 }, extra: 1 }], meta: { responseId: 'r', checkpoint: 'c', model: 'm', usage: { input: 1 } } },
        { role: 'user', parts: [{ type: 'tool_result', id: 't' }] },
      ],
    }],
  }));
  assert.deepEqual(parsed.chats, [{
    title: 'Untitled', archived: false, project: null,
    messages: [
      { role: 'assistant', createdAt: T0, parts: [text('ok'), { type: 'tool_call', id: 'c', name: 'n', args: { a: 1 } }], meta: { model: 'm' } },
      { role: 'user', parts: [{ type: 'tool_result', id: 't', name: '', output: '' }] },
    ],
  }]);
});
