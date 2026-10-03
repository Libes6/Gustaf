// Webview hardening checks that run without Tauri:
//  1. the CSP in tauri.conf.json is parsed and compared with an explicit allow-list per directive;
//  2. the frontend is really built (vite build into a temp dir) and the output is scanned for things the CSP would block
//     or that would force it open (inline scripts, eval, external resources);
//  3. if a local Chrome exists, the production build is served with the production CSP as a response header (as Tauri does
//     for index.html) and driven over the DevTools protocol: the app must boot without violations, and the canvas iframe
//     must still run (nonce'd external script, eval, inline styles) while staying isolated.
//  4. capabilities/default.json is checked for the narrowing decisions documented in docs/features/security.md.
// Not covered (needs the real app): WKWebView/WebKit behaviour. Chrome (Blink) implements the same CSP3 inheritance rules,
// but the manual checklist in README.md ("Security") still has to be run once in `tauri dev`.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasDocument, CANVAS_RUNTIME_URL } from '../src/canvas/document.ts';
import { findChrome, launchChrome } from './helpers/chrome.mjs';
import { viteBin } from './helpers/viteBin.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const caps = JSON.parse(readFileSync(join(root, 'src-tauri/capabilities/default.json'), 'utf8'));
const security = conf.app.security;

/** Tauri accepts a string or a { directive: string | string[] } map; both become one policy string. */
const cspString = (csp) => typeof csp === 'string' ? csp : Object.entries(csp).map(([k, v]) => `${k} ${[].concat(v).join(' ')}`).join('; ');
const parseCsp = (csp) => Object.fromEntries(cspString(csp).split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...src] = d.split(/\s+/); return [name, src]; }));

// ---------------------------------------------------------------------------------------------------------------------
// 1. Policy shape
// ---------------------------------------------------------------------------------------------------------------------

/** The only sources each directive may contain. Loosening the policy means editing this list on purpose. */
const ALLOWED = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
  'frame-src': ['about:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
};
const DEV_EXTRA = {
  'script-src': ["'unsafe-inline'"], // Vite's React refresh preamble is an inline module script
  'connect-src': ['ws://localhost:1420', 'http://localhost:1420'], // Vite HMR
};

test('production CSP is set and every source is on the allow-list', () => {
  assert.ok(security.csp, 'app.security.csp must not be null: the webview would run without a CSP');
  const policy = parseCsp(security.csp);
  for (const name of Object.keys(ALLOWED)) assert.ok(policy[name], `directive ${name} is missing`);
  for (const [name, sources] of Object.entries(policy)) {
    assert.ok(ALLOWED[name], `unexpected directive ${name}: review it, then add it to ALLOWED in tests/csp.test.mjs`);
    for (const s of sources) assert.ok(ALLOWED[name].includes(s), `${name} gained source ${s}: review it, then add it to ALLOWED in tests/csp.test.mjs`);
  }
});

test('dev CSP only adds what Vite needs on top of the production policy', () => {
  assert.ok(security.devCsp, 'app.security.devCsp is missing');
  const dev = parseCsp(security.devCsp);
  for (const [name, sources] of Object.entries(dev)) {
    const allowed = [...(ALLOWED[name] ?? []), ...(DEV_EXTRA[name] ?? [])];
    assert.ok(ALLOWED[name], `unexpected dev directive ${name}`);
    for (const s of sources) assert.ok(allowed.includes(s), `devCsp ${name} gained source ${s}`);
  }
  assert.ok(dev['connect-src'].includes('ws://localhost:1420'), 'devCsp must allow the Vite HMR websocket');
});

test('production policy has no escape hatches for scripts or network', () => {
  const p = parseCsp(security.csp);
  assert.ok(!p['script-src'].includes("'unsafe-inline'"), "script-src 'unsafe-inline' would also void Tauri's nonces/hashes");
  for (const [name, sources] of Object.entries(p)) for (const s of sources) {
    assert.ok(!/^\*$|^https?:$|^https?:\/\/\*|^ws:$|^wss:$/.test(s), `${name} ${s} is a wildcard/scheme-wide source`);
    if (name !== 'img-src' && name !== 'font-src') assert.ok(s !== 'data:' && s !== 'blob:', `${name} must not allow ${s}`);
  }
  assert.deepEqual(p['connect-src'].filter((s) => /^https?:/.test(s)), ['http://ipc.localhost'], 'network goes through plugin-http (IPC), not the webview');
});

test("Tauri's automatic nonce/hash injection stays enabled", () => {
  const flag = security.dangerousDisableAssetCspModification;
  assert.ok(flag === undefined || flag === false, 'dangerousDisableAssetCspModification must stay off');
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Source and build output
// ---------------------------------------------------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

test('source: no new network/frame/script surfaces that the CSP was not designed for', () => {
  const files = walk(join(root, 'src')).filter((f) => /\.(tsx?|css)$/.test(f) && !f.includes(`${sep}generated${sep}`));
  const rules = [
    [/new\s+WebSocket\s*\(/, 'WebSocket (connect-src has no ws:)'],
    [/new\s+EventSource\s*\(/, 'EventSource'],
    [/sendBeacon\s*\(/, 'sendBeacon'],
    [/new\s+(Shared)?Worker\s*\(/, 'Worker (no worker-src)'],
    [/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write\s*\(/, 'raw HTML injection'],
    [/createElement\(\s*["'`]script/, 'dynamic script element'],
    [/@import|url\(\s*["']?https?:/, 'CSS remote import'],
    [/\beval\s*\(/, 'eval'],
    [/<(img|source|video|audio|link|embed|object)\b[^>]*\b(src|href)=["']https?:/, 'remote resource in markup'],
  ];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const [re, what] of rules) assert.ok(!re.test(text), `${f.slice(root.length)}: ${what}. Review the CSP (tests/csp.test.mjs, docs/features/security.md) before allowing it.`);
  }
  const iframes = files.filter((f) => /<iframe\b/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length));
  assert.deepEqual(iframes, ['src/components/CanvasPanel.tsx', 'src/components/ShareHtmlDialog.tsx'], 'only the canvas panel and the share-as-HTML preview may create an iframe');
  const share = readFileSync(join(root, 'src/components/ShareHtmlDialog.tsx'), 'utf8');
  assert.match(share, /sandbox=""/, 'the share preview frame must be fully sandboxed (no scripts)');
  const panel = readFileSync(join(root, 'src/components/CanvasPanel.tsx'), 'utf8');
  assert.match(panel, /sandbox="allow-scripts"/, 'canvas iframe must keep sandbox="allow-scripts"');
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/.test(panel), 'canvas sandbox must not gain capabilities');
});

test('canvas document: no inline code, nonce on the only script, hardened own CSP', () => {
  const html = canvasDocument('export default () => null;');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2, 'payload (application/json) and runtime only');
  const nonce = /content-security-policy[^>]*script-src 'nonce-([0-9a-f]+)'/i.exec(html)?.[1];
  assert.ok(nonce, 'canvas CSP must carry a nonce');
  assert.ok(scripts.some((a) => /type="application\/json"/.test(a)), 'payload must be a non-executable JSON script');
  const runtime = scripts.find((a) => /src=/.test(a));
  assert.ok(runtime?.includes(`nonce="${nonce}"`) && runtime.includes(`src="${CANVAS_RUNTIME_URL}"`), 'runtime must be an external nonce\'d script');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  for (const needed of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) assert.ok(meta.includes(needed), `canvas CSP lost ${needed}`);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(meta), 'canvas script-src must not allow inline scripts');
});

/** Text only the canvas runtime contains: files with it are canvas copies (lazy raw-string chunks), not app code. */
const RUNTIME_MARK = 'Export a React component with export default';
let dist;
let built = false;
const SKIP_BUILD = process.env.MCODE_CSP_SKIP_BUILD === '1';

before(() => {
  if (SKIP_BUILD) return;
  dist = mkdtempSync(join(tmpdir(), 'mcode-dist-'));
  execFileSync(process.execPath, ['scripts/build-canvas.mjs'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [viteBin, 'build', '--outDir', dist, '--emptyOutDir'], { cwd: root, stdio: 'pipe' });
  built = true;
});
after(() => { if (dist) rmSync(dist, { recursive: true, force: true }); });

/** Hosts that appear in the bundle as constants (provider presets, doc links, XML namespaces), never as loaded resources. */
const KNOWN_HOSTS = new Set([
  // 127.0.0.1: the OAuth redirect URI string (mcp/oauth.ts); the listener is Rust and the webview never loads it.
  'www.w3.org', 'react.dev', 'github.com', 'localhost', '127.0.0.1', 'example.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com',
  'openrouter.ai', 'platform.openai.com', 'aistudio.google.com', 'console.anthropic.com', 'cursor.com', 'claude.ai', 'chatgpt.com', 'developers.openai.com',
]);

test('build: index.html has no inline script, inline handler, style block or external reference', (t) => {
  if (!built) return t.skip('build skipped');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /\bsrc="\/assets\//, `inline <script> in index.html (CSP script-src has no 'unsafe-inline'): ${m[0].slice(0, 120)}`);
    assert.equal(m[2].trim(), '', 'script with src must be empty');
  }
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline event handler attribute in index.html');
  assert.ok(!/<style\b/i.test(html), 'a <style> block in index.html would need a hash/nonce');
  assert.ok(!/\sstyle\s*=/i.test(html), 'inline style attribute in index.html');
  for (const m of html.matchAll(/\b(?:src|href)="([^"]+)"/g)) assert.ok(m[1].startsWith('/') && !m[1].startsWith('//'), `external reference in index.html: ${m[1]}`);
});

test('build: the main bundle needs no eval, so script-src unsafe-eval is only for the canvas frame', (t) => {
  if (!built) return t.skip('build skipped');
  // The canvas runtime also ships as raw strings in lazy chunks (standalone HTML export); those copies are the canvas, not the app.
  let appChunks = 0;
  for (const f of walk(join(dist, 'assets')).filter((p) => p.endsWith('.js'))) {
    const js = readFileSync(f, 'utf8');
    if (js.includes(RUNTIME_MARK)) continue;
    appChunks++;
    assert.ok(!/\beval\s*\(/.test(js), `${f.slice(dist.length)} uses eval(`);
    assert.ok(!/(^|[^\w.$])new\s+Function\s*\(|(^|[^\w.$])Function\s*\(\s*["'`]/.test(js), `${f.slice(dist.length)} uses new Function(...). script-src 'unsafe-eval' is then needed by the app itself, not just the canvas: update docs/features/security.md and this test.`);
    assert.ok(!/(setTimeout|setInterval)\(\s*["'`]/.test(js), `${f.slice(dist.length)} passes a string to a timer`);
  }
  assert.ok(appChunks >= 2, 'expected the main chunk and the lazy CanvasPanel chunk to be scanned');
  const runtime = readFileSync(join(dist, 'canvas/runtime.js'), 'utf8');
  assert.match(runtime, /new Function\(/, 'the canvas runtime is the one place that evaluates code');
  assert.ok(existsSync(join(dist, 'canvas/runtime-icons.js')), 'icons runtime missing (loaded for sources that import lucide-react)');
});

test('build: no external URL outside the known constants, no remote CSS references', (t) => {
  if (!built) return t.skip('build skipped');
  for (const f of walk(join(dist, 'assets'))) {
    const text = readFileSync(f, 'utf8');
    if (text.includes(RUNTIME_MARK)) continue; // runs in the sandbox with connect-src 'none'
    if (f.endsWith('.css')) assert.ok(!/@import|url\(\s*["']?(https?:|\/\/)/.test(text), `${f.slice(dist.length)}: remote CSS reference`);
    for (const m of text.matchAll(/(?:https?|wss?):\/\/([A-Za-z0-9.-]+)/g)) {
      assert.ok(KNOWN_HOSTS.has(m[1]), `${f.slice(dist.length)}: new external host ${m[1]} (${m[0]}). If it is loaded by the webview, add it to the CSP; if it is only an API/doc link (plugin-http / opener), add it to KNOWN_HOSTS.`);
    }
  }
  assert.ok(existsSync(join(dist, 'canvas/runtime.js')), 'dist/canvas/runtime.js missing: the canvas iframe loads it with <script src>');
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Real browser (Chrome/Blink) with the production CSP as a response header, like Tauri serves index.html
// ---------------------------------------------------------------------------------------------------------------------

const CANVAS_PROBE = `export default function Probe() {
  React.useEffect(() => { (async () => {
    let fetchBlocked = false, parentBlocked = false, evalWorks = false;
    const violated = [];
    document.addEventListener('securitypolicyviolation', (e) => violated.push(e.violatedDirective));
    try { await fetch('https://example.com/'); } catch { fetchBlocked = true; }
    try { parent.document.title; } catch { parentBlocked = true; }
    try { evalWorks = new Function('return 7')() === 7; } catch {}
    await new Promise((r) => setTimeout(r, 100));
    parent.postMessage({ type: 'probe', violated, text: document.getElementById('probe').textContent, fetchBlocked, parentBlocked, evalWorks, styled: getComputedStyle(document.getElementById('probe')).color }, '*');
  })(); }, []);
  return <div id="probe" style={{ color: 'rgb(1, 2, 3)' }}>hello canvas</div>;
}`;

const CANVAS_ICONS = `import { Heart } from "lucide-react";
export default function Icons() {
  React.useEffect(() => { parent.postMessage({ type: 'icons', svg: !!document.querySelector('#icon svg') }, '*'); }, []);
  return <div id="icon"><Heart /></div>;
}`;

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
/** What the canvas looked like before: an inline nonce'd bootstrap. Under the app's CSP (no nonce) it must be refused. */
const legacyInlineDocument = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-abc' 'unsafe-eval'"><script nonce="abc">parent.postMessage({ type: 'inline-ran' }, '*')</script>`;

function serve(dir, cspHeader) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const fixture = `<!doctype html><title>csp fixture</title><script src="/__csp/page.js"></script>
<iframe id="good" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${attr(canvasDocument(CANVAS_PROBE))}"></iframe>
<iframe id="icons" sandbox="allow-scripts" srcdoc="${attr(canvasDocument(CANVAS_ICONS))}"></iframe>
<iframe id="legacy" sandbox="allow-scripts" srcdoc="${attr(legacyInlineDocument)}"></iframe>`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x').pathname;
    const send = (body, type, html) => { res.writeHead(200, { 'content-type': type, ...(html ? { 'content-security-policy': cspHeader } : {}) }); res.end(body); };
    if (url === '/__csp/canvas.html') return send(fixture, 'text/html', true);
    if (url === '/__csp/canvas-nocsp.html') return send(fixture, 'text/html', false); // control: same page without the app CSP
    if (url === '/__csp/page.js') return send('window.__msgs = []; addEventListener("message", (e) => window.__msgs.push(e.data));', 'text/javascript');
    const file = normalize(join(dir, url === '/' ? 'index.html' : url));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    send(readFileSync(file), mime[extname(file)] ?? 'application/octet-stream', file.endsWith('.html'));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** The app talks to Rust through invoke(); outside Tauri every command resolves to "nothing" so the UI can render. */
const TAURI_STUB = `window.__TAURI_INTERNALS__ = { invoke: async (cmd) => cmd === 'db_select' || cmd === 'db_execute' ? (cmd === 'db_select' ? [] : [0, 0]) : null, transformCallback: () => 1, unregisterCallback() {}, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } } };`;

const violations = (messages) => messages.filter((m) => /Content Security Policy|Refused to/i.test(m));

test('browser: the production build boots under the production CSP without violations', async (t) => {
  if (!built) return t.skip('build skipped');
  const chrome = await launchChrome();
  if (!chrome) return t.skip(`no local Chrome (set CHROME_BIN); found: ${findChrome()}`);
  const { server, origin } = await serve(dist, cspString(security.csp));
  try {
    const page = await chrome.open(`${origin}/`, { init: TAURI_STUB });
    const rendered = await page.waitFor("document.getElementById('root') && document.getElementById('root').children.length > 0");
    await new Promise((r) => setTimeout(r, 1500));
    assert.deepEqual(violations(page.messages), [], 'CSP violations while loading the app:\n' + page.messages.join('\n'));
    assert.ok(rendered, 'the app did not render anything:\n' + page.messages.join('\n'));
  } finally { server.close(); await chrome.close(); }
});

test('browser: canvas srcdoc iframe still runs under the parent CSP and stays isolated', async (t) => {
  if (!built) return t.skip('build skipped');
  const chrome = await launchChrome();
  if (!chrome) return t.skip('no local Chrome (set CHROME_BIN)');
  const { server, origin } = await serve(dist, cspString(security.csp));
  try {
    const page = await chrome.open(`${origin}/__csp/canvas.html`);
    const got = await page.waitFor("window.__msgs && ['probe', 'icons'].every(t => window.__msgs.some(m => m && m.type === t))");
    assert.ok(got, 'the canvas never reported back (script, eval or style blocked?):\n' + page.messages.join('\n'));
    await new Promise((r) => setTimeout(r, 500));
    const msgs = await page.eval('window.__msgs');
    const probe = msgs.find((m) => m?.type === 'probe');
    assert.equal(probe.text, 'hello canvas', 'component did not render');
    assert.equal(probe.evalWorks, true, "new Function inside the canvas is blocked: parent script-src needs 'unsafe-eval'");
    assert.equal(probe.styled, 'rgb(1, 2, 3)', 'inline style did not apply (style-src)');
    assert.equal(probe.fetchBlocked, true, 'canvas can reach the network');
    assert.equal(probe.parentBlocked, true, 'canvas can read the parent document');
    assert.equal(msgs.find((m) => m?.type === 'icons')?.svg, true, 'the lucide-react canvas (runtime-icons.js) did not render');
    assert.ok(!msgs.some((m) => m?.type === 'mcode-canvas-error'), 'canvas runtime reported an error: ' + JSON.stringify(msgs));
    assert.ok(!msgs.some((m) => m?.type === 'inline-ran'), 'an inline script ran under the app CSP (inheritance assumption is wrong)');
    assert.deepEqual([...new Set(probe.violated)], ['connect-src'], 'the only refusal inside the canvas may be its own fetch: ' + JSON.stringify(probe.violated));
    // Control: without the app CSP the legacy inline bootstrap does run, so its absence above is caused by the inherited policy.
    const control = await chrome.open(`${origin}/__csp/canvas-nocsp.html`);
    assert.ok(await control.waitFor("window.__msgs && window.__msgs.some(m => m && m.type === 'inline-ran')"), 'control failed: the legacy inline script should run when the parent has no CSP');
  } finally { server.close(); await chrome.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Capabilities
// ---------------------------------------------------------------------------------------------------------------------

const perms = caps.permissions;
const scoped = (id) => perms.find((p) => typeof p === 'object' && p.identifier === id);

test('capabilities: http scope has no catch-all and no duplicates', () => {
  const urls = scoped('http:default').allow.map((a) => a.url);
  assert.ok(!urls.some((u) => /^http:\/\/\*(:\*)?$/.test(u)), 'http://* lets the app send API keys in clear text to any host');
  assert.ok(urls.includes('https://*'));
  assert.equal(new Set(urls).size, urls.length, 'duplicate http scope entries');
  for (const u of urls) assert.ok(/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1|\\\[|\(|\[|\*\.[a-z.]+:\*$)/.test(u), `unexpected http scope entry ${u}`);
});

test('capabilities: the http scope covers the OAuth endpoints the MCP sign-in accepts (https anywhere, http on loopback) and nothing weaker', () => {
  // The scope entries are URL patterns; `*` is a wildcard and `( )` groups are regular expressions. Close enough for a shape check.
  const rx = scoped('http:default').allow.map((a) => new RegExp('^' + a.url.replace(/\*/g, '.*') + '$'));
  const covered = (u) => rx.some((r) => r.test(u));
  // Discovery documents, registration, token and refresh requests all go through plugin-http, so they must be allowed ...
  for (const u of [
    'https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp',
    'https://auth.example.com/.well-known/oauth-authorization-server',
    'https://auth.example.com:8443/register',
    'https://auth.example.com/oauth2/token',
    'http://localhost:9000/token',
    'http://127.0.0.1:9000/.well-known/oauth-authorization-server',
  ]) assert.ok(covered(u), `${u} must be inside the http scope for OAuth to work`);
  // ... and a public authorization server over plain http (mcp/oauth.ts refuses it too) stays outside it.
  for (const u of ['http://auth.example.com/token', 'http://8.8.8.8/token', 'http://auth.example.com:80/token']) assert.ok(!covered(u), `${u} must not be reachable`);
  // The browser step needs no capability beyond opening default URLs (https/http) with the opener plugin.
  assert.ok(perms.includes('opener:allow-default-urls'));
});

test('capabilities: shell is limited to `zsh -lc <script>`', () => {
  for (const id of ['shell:allow-spawn', 'shell:allow-execute']) {
    const entry = scoped(id);
    assert.equal(entry.allow.length, 1);
    const [{ name, cmd, args }] = entry.allow;
    assert.equal(name, 'zsh');
    assert.equal(cmd, '/bin/zsh');
    assert.ok(Array.isArray(args), 'args: true would allow any arguments');
    assert.equal(args[0], '-lc');
    assert.equal(args.length, 2);
  }
});

test('capabilities: broad plugin defaults stay replaced by the permissions actually used', () => {
  const ids = perms.map((p) => typeof p === 'string' ? p : p.identifier);
  for (const broad of ['dialog:default', 'opener:default', 'notification:default', 'shell:default', 'global-shortcut:default', 'core:window:default']) assert.ok(!ids.includes(broad), `${broad} grants more than the app uses`);
  for (const unused of ['core:window:allow-show', 'core:window:allow-hide', 'core:window:allow-set-focus']) assert.ok(!ids.includes(unused), `${unused} is not called from the frontend (computer.rs hides/shows the window in Rust)`);
  assert.equal(new Set(ids).size, ids.length, 'duplicate permission entries');
});
