// End-to-end harness: the real production frontend (vite build) in a real Chrome (playwright-core, no bundled
// browsers: the locally installed Chrome is used, see tests/helpers/chrome.mjs), with a faked Tauri backend
// (tests/e2e/fakeBackend.mjs + tauriInit.js). The page is served with the production CSP from tauri.conf.json as a
// response header (like Tauri does), so a CSP violation shows up as a console error and fails the scenario.
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChrome } from '../helpers/chrome.mjs';
import { buildFrontend } from './build.mjs';
import { FakeBackend } from './fakeBackend.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const ARTIFACTS = join(root, 'tests/e2e/artifacts'); // git-ignored; filled only when a scenario fails
const INIT = readFileSync(join(root, 'tests/e2e/tauriInit.js'), 'utf8');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const csp = (() => {
  const c = conf.app.security.csp;
  return typeof c === 'string' ? c : Object.entries(c).map(([k, v]) => `${k} ${[].concat(v).join(' ')}`).join('; ');
})();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };

export const chromePath = findChrome();
export const skipReason = chromePath ? false : 'no local Chrome/Chromium found (set CHROME_BIN to run the end-to-end tests)';

/** The built frontend: `E2E_DIST` (set by tests/e2e/run.mjs, which builds once) or a private build for this process. */
function distDir() {
  if (process.env.E2E_DIST) return process.env.E2E_DIST;
  const dir = mkdtempSync(join(tmpdir(), 'mcode-e2e-dist-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  buildFrontend(dir);
  return dir;
}


function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = normalize(join(dir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(dir + sep) && file !== dir) { res.writeHead(403).end(); return; }
    if (url.pathname === '/') file = join(dir, 'index.html');
    if (!existsSync(file)) {
      // Tauri answers every asset it has; the Vite template's favicon is not part of the bundle.
      res.writeHead(url.pathname === '/vite.svg' ? 204 : 404).end();
      return;
    }
    const headers = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' };
    if (file.endsWith('.html')) headers['content-security-policy'] = csp;
    res.writeHead(200, headers).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

/** One browser + static server per test file. Call in `before`; `close()` in `after`. */
export async function startSuite() {
  const dist = distDir();
  const { server, origin } = await serve(dist);
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    chromiumSandbox: !(process.env.CI || process.getuid?.() === 0),
  });
  return {
    origin,
    browser,
    async close() { await browser.close(); server.close(); },
  };
}

/** Console output that must never happen: errors (CSP violations are errors), and anything that mentions a refusal. */
const isProblem = (m) => m.type() === 'error' || /Refused to|violates the following Content Security Policy/.test(m.text());

/**
 * Runs one scenario in a fresh browser context with its own fake backend.
 * `fn({ page, backend, origin })`; `setup(backend)` runs first (seed data, script the provider).
 * The scenario fails when the page logged a console error / CSP refusal or threw an uncaught exception.
 * On failure a screenshot and a Playwright trace go to tests/e2e/artifacts/.
 */
export async function scenario(suite, name, { setup, locale = 'en-US', colorScheme = 'light', artifacts = true } = {}, fn) {
  const backend = new FakeBackend();
  setup?.(backend);
  const context = await suite.browser.newContext({ locale, colorScheme, viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true });
  await context.exposeBinding('__e2e_invoke', async (_src, cmd, args) => backend.invoke(cmd, args ?? {}));
  await context.addInitScript({ content: INIT });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const problems = [];
  page.on('console', (m) => { if (isProblem(m)) problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.stack ?? e.message}`));
  let failed = true;
  try {
    await fn({ page, backend, origin: suite.origin, context, problems });
    if (problems.length) throw new Error(`page logged problems:\n${problems.join('\n')}`);
    failed = false;
  } finally {
    if (failed && artifacts) {
      mkdirSync(ARTIFACTS, { recursive: true });
      const base = join(ARTIFACTS, name.replace(/[^a-z0-9]+/gi, '-').toLowerCase());
      await page.screenshot({ path: `${base}.png` }).catch(() => {});
      writeFileSync(`${base}.backend-calls.json`, JSON.stringify({ problems, calls: backend.calls.filter(([c]) => c !== 'db_select' && c !== 'db_execute') }, null, 1));
      await context.tracing.stop({ path: `${base}.trace.zip` }).catch(() => {});
    } else await context.tracing.stop().catch(() => {});
    await context.close();
  }
}

/** Opens the app and waits until the shell rendered (onboarding or the main window). */
export async function openApp(page, origin) {
  await page.goto(origin + '/');
  await page.locator('.onboarding, .app').first().waitFor();
}

/** Waits until a locator is visible (the scenario fails on timeout: no fixed sleeps anywhere). */
export const shown = (locator) => locator.waitFor({ state: 'visible' });
export const gone = (locator) => locator.waitFor({ state: 'detached' });

/** Polls a condition until it holds, for state that is not on screen (backend rows, requests). */
export async function until(fn, what = 'condition', ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
