// "Share as HTML": the pure page builder (src/lib/shareHtml.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./helpers/hooks.mjs', import.meta.url);
const { buildShareHtml, shareFileName, markdownToHtml, SHARE_CSP, SHARE_TEXT_LIMIT, SHARE_OUTPUT_LIMIT } = await import('../src/lib/shareHtml.ts');

const NOW = Date.UTC(2026, 9, 2, 12, 30, 15);
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);
const text = (t) => ({ type: 'text', text: t });
const msg = (role, parts, extra = {}) => ({ role, parts, ...extra });
const source = (messages, over = {}) => ({ chat: { title: 'Fix login', created_at: T0, updated_at: T0 + 60_000 }, project: { name: 'web-app', path: '/Users/me/web-app' }, messages, ...over });
const build = (messages, opts = {}, over = {}) => buildShareHtml(source(messages, over), { now: NOW, ...opts });
const KEY = 'sk-ant-api03-' + 'a1B2c3D4e5F6g7H8i9J0k1L2';

test('a page is self-contained: strict CSP meta, no scripts, no external loads, light/dark/print', () => {
  const { html } = build([msg('user', [text('Hello **world** [link](https://example.com) ![pic](https://evil.example/x.png)')]), msg('assistant', [text('Hi')], { meta: { model: 'gpt-5' } })]);
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${SHARE_CSP}">`));
  assert.match(SHARE_CSP, /default-src 'none'/);
  assert.doesNotMatch(SHARE_CSP, /script-src|connect-src|http/);
  assert.doesNotMatch(html, /<script|<link|<iframe|@import|url\(|<img|src=/i, 'nothing that loads or runs');
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /@media print/);
  assert.match(html, /<title>Fix login<\/title>/);
  assert.match(html, /<strong>world<\/strong>/);
  assert.match(html, /\[image: pic\]/, 'remote images become text');
  assert.ok(!html.includes('evil.example'), 'the remote image address is not in the page');
  assert.match(html, /Model: gpt-5/);
  assert.match(html, /web-app/);
});

test('HTML and script tags in messages, titles and tool data are escaped, not executed', () => {
  const evil = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';
  const { html } = build(
    [
      msg('user', [text(`${evil}\n\n\`\`\`html\n${evil}\n\`\`\``)]),
      msg('assistant', [{ type: 'tool_call', id: 'c1', name: '<b>x</b>', args: { command: evil } }]),
      msg('tool', [{ type: 'tool_result', id: 'c1', name: 'x', output: evil }]),
    ],
    {},
    { chat: { title: `<script>alert(3)</script>${evil}`, created_at: T0, updated_at: T0 } },
  );
  assert.doesNotMatch(html, /<script|<img|onerror=alert\(\d\)>/i);
  assert.ok(!html.includes('<b>x</b>'));
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /<title>&lt;script&gt;/);
});

test('javascript: links are not rendered as links', () => {
  const { html } = build([msg('assistant', [text('[x](javascript:alert(1)) [y](https://ok.example)')])]);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/ok\.example"/);
});

test('secrets are redacted everywhere and counted for the review step', () => {
  const m = [
    msg('user', [text(`my key is ${KEY}`)]),
    msg('assistant', [{ type: 'tool_call', id: 'c1', name: 'run_command', args: { command: `curl -H "Authorization: Bearer ${'x'.repeat(30)}" https://api.example` } }]),
    msg('tool', [{ type: 'tool_result', id: 'c1', name: 'run_command', output: 'API_KEY=supersecretvalue123\nok' }]),
  ];
  const { html, redactions } = build(m);
  assert.ok(!html.includes(KEY));
  assert.ok(!html.includes('supersecretvalue123'));
  assert.ok(!html.includes('x'.repeat(30)));
  assert.match(html, /\[REDACTED\]/);
  assert.equal(redactions, 3);
  assert.equal(build([msg('user', [text('nothing secret')])]).redactions, 0);
});

test('tool cards pair a call with its result: command, clipped output, status; errors are marked', () => {
  const big = 'line\n'.repeat(5000);
  const { html } = build([
    msg('assistant', [
      { type: 'tool_call', id: 'c1', name: 'run_command', args: { command: 'npm test' } },
      { type: 'tool_call', id: 'c2', name: 'run_command', args: { command: 'ls' } },
    ]),
    msg('tool', [
      { type: 'tool_result', id: 'c1', name: 'run_command', output: big, isError: true },
      { type: 'tool_result', id: 'c2', name: 'run_command', output: 'a.txt' },
    ]),
  ]);
  assert.equal((html.match(/class="card tool/g) ?? []).length, 2, 'one card per call, results are merged in');
  assert.match(html, /class="cmd">npm test</);
  assert.match(html, /badge err">Failed/);
  assert.match(html, /badge ok">Completed/);
  assert.match(html, /more characters not shown/);
  assert.ok(html.length < SHARE_OUTPUT_LIMIT * 3);
});

test('an unpaired result and a native activity still render', () => {
  const { html } = build([
    msg('tool', [{ type: 'tool_result', id: 'zz', name: 'read_file', output: 'contents' }]),
    msg('assistant', [{ type: 'activity', id: 'a', name: 'bash', args: { command: 'ls' }, status: 'running' }]),
  ]);
  assert.match(html, /contents/);
  assert.match(html, /badge run">Running/);
});

test('file edits render as a diff; written files show their path', () => {
  const { html } = build([
    msg('assistant', [
      { type: 'tool_call', id: 'e', name: 'edit_file', args: { path: 'src/a.ts', old_string: 'a\nb', new_string: 'a\nc' } },
      { type: 'tool_call', id: 'w', name: 'write_file', args: { path: 'src/b.ts', content: 'export {}' } },
    ]),
  ]);
  assert.match(html, /<span class="del">- b<\/span>/);
  assert.match(html, /<span class="add">\+ c<\/span>/);
  assert.match(html, /class="path">src\/a\.ts</);
  assert.match(html, /class="path">src\/b\.ts<\/div><pre>export \{\}/);
});

test('canvas artifacts are shown as source blocks, not run', () => {
  const { html } = build([msg('assistant', [text('Here:\n\n```tsx-canvas title="Counter <b>"\nexport default () => <div onClick={() => alert(1)}>x</div>\n```\n\nbye')])]);
  assert.match(html, /class="card canvas"/);
  assert.match(html, /Canvas: Counter &lt;b&gt;/);
  assert.match(html, /export default \(\) =&gt; &lt;div onClick/);
  assert.doesNotMatch(html, /<div onClick/);
});

test('code blocks keep the highlight classes, which are styled inline', () => {
  const { html } = build([msg('assistant', [text('```ts\nconst a = "x";\n```')])]);
  assert.match(html, /class="hljs-keyword"/);
  assert.match(html, /\.hljs-keyword/);
  assert.match(markdownToHtml('```js\nlet x = 1\n```'), /hljs-keyword/);
});

test('images are omitted by default and embedded as data: URIs on request', () => {
  const png = 'iVBORw0KGgo=';
  const m = [msg('user', [text('see'), { type: 'image', data: png }]), msg('tool', [{ type: 'tool_result', id: 't', name: 'shot', output: 'ok', image: png }])];
  const off = build(m).html;
  assert.doesNotMatch(off, /<img|base64/);
  assert.match(off, /\[image omitted\]/);
  const on = build(m, { includeImages: true }).html;
  assert.ok(on.includes(`<img src="data:image/png;base64,${png}"`));
  assert.doesNotMatch(on, /https?:\/\/[^"' ]*\.(png|jpe?g)/);
  const bad = build([msg('user', [{ type: 'image', data: 'AAAA"onerror="x' }])], { includeImages: true }).html;
  assert.doesNotMatch(bad, /onerror="x/);
});

test('unicode survives; huge messages are clipped with a note', () => {
  const { html } = build([msg('user', [text('Привет, мир 👋 日本語 \u{1F600}')]), msg('assistant', [text('x'.repeat(SHARE_TEXT_LIMIT + 5000))])]);
  assert.match(html, /Привет, мир 👋 日本語 \u{1F600}/u);
  assert.match(html, /5000 more characters not shown/);
  assert.ok(html.length < SHARE_TEXT_LIMIT + 60_000);
  // A cut never splits a surrogate pair.
  const cut = build([msg('assistant', [text('a'.repeat(SHARE_TEXT_LIMIT - 1) + '\u{1F600}tail')])]).html;
  assert.doesNotMatch(cut, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('an empty chat and an untitled chat still produce a page', () => {
  const r = build([], {}, { chat: { title: '   ', created_at: T0, updated_at: T0 } });
  assert.match(r.html, /<title>Untitled<\/title>/);
  assert.equal(r.messages, 0);
});

test('file names come from the title and stay safe', () => {
  assert.equal(shareFileName('Fix login: a/b?'), 'Fix-login-a-b.html');
  assert.equal(shareFileName('///'), 'chat.html');
  assert.equal(shareFileName('Привет мир'), 'Привет-мир.html');
});
