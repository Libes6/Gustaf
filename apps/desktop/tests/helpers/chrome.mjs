// Minimal headless Chrome driver over the DevTools protocol (no playwright/puppeteer dependency, nothing is downloaded).
// Used by tests/csp.test.mjs; every function degrades to "no browser" so the test can skip that part.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** Path of a locally installed Chrome/Chromium (also a playwright cache entry), or null. */
export function findChrome() {
  for (const p of CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Starts headless Chrome and returns `{ open(url), close() }`; `open` resolves to a page with `messages`, `eval`, `waitFor`. */
export async function launchChrome(bin = findChrome()) {
  if (!bin || typeof WebSocket === 'undefined') return null;
  const profile = mkdtempSync(join(tmpdir(), 'mcode-chrome-'));
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--disable-background-networking',
    // CI containers/runners (root, or AppArmor-restricted user namespaces) cannot start Chrome's sandbox; the page is our own static build.
    ...(process.env.CI || process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    'about:blank',
  ], { stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const portFile = join(profile, 'DevToolsActivePort');
  let endpoint = null;
  for (let i = 0; i < 100 && !endpoint && !exited; i++) {
    await sleep(100);
    try {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
    } catch { /* not written yet */ }
  }
  const cleanup = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };
  if (!endpoint) { cleanup(); return null; }

  const ws = new WebSocket(endpoint);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools connection failed')); });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(`${m.error.message}`)) : res(m.result);
    } else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  return {
    async open(url, { init } = {}) {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      /** Console output and browser log entries (CSP violations show up here as "Refused to ..."). */
      const messages = [];
      listeners.add((m) => {
        if (m.sessionId !== sessionId) return;
        if (m.method === 'Runtime.consoleAPICalled') messages.push(`console.${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
        if (m.method === 'Runtime.exceptionThrown') messages.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
        if (m.method === 'Log.entryAdded') messages.push(`log.${m.params.entry.level}(${m.params.entry.source}): ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
      });
      await send('Runtime.enable', {}, sessionId);
      await send('Log.enable', {}, sessionId);
      await send('Page.enable', {}, sessionId);
      if (init) await send('Page.addScriptToEvaluateOnNewDocument', { source: init }, sessionId);
      await send('Page.navigate', { url }, sessionId);
      const page = {
        messages,
        async eval(expression) {
          const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
          return r.result.value;
        },
        async waitFor(expression, ms = 8000) {
          for (let t = 0; t < ms; t += 100) {
            try { const v = await page.eval(expression); if (v) return v; } catch { /* page still loading */ }
            await sleep(100);
          }
          return null;
        },
      };
      return page;
    },
    async close() { try { ws.close(); } catch { /* closed */ } cleanup(); },
  };
}
