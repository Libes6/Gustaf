// `npm run test:e2e`: builds the frontend once, then runs every tests/e2e/*.test.mjs (one browser per file, two files at a time)
// against that build. Exits 0 with a message when no local Chrome exists (the suite is optional, like the browser part of
// tests/csp.test.mjs); set CHROME_BIN to point at a Chrome/Chromium binary.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from '../helpers/chrome.mjs';
import { buildFrontend } from './build.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const chrome = findChrome();
if (!chrome) {
  console.log('test:e2e skipped: no local Chrome/Chromium found (set CHROME_BIN to run the end-to-end tests).');
  process.exit(0);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.log(`test:e2e skipped: Node ${process.versions.node} has no node:sqlite without a flag (needs 22.13+, see .nvmrc).`);
  process.exit(0);
}
console.log(`test:e2e using ${chrome}`);

const dist = mkdtempSync(join(tmpdir(), 'gustaf-e2e-dist-'));
let code = 1;
try {
  buildFrontend(dist);
  const files = readdirSync(join(root, 'tests/e2e')).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `tests/e2e/${f}`);
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=spec', '--test-concurrency=2', ...files, ...process.argv.slice(2)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, E2E_DIST: dist },
  });
  code = r.status ?? 1;
} finally {
  rmSync(dist, { recursive: true, force: true });
}
process.exit(code);
