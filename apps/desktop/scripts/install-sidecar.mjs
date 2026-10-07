// Reinstalls sidecar/node_modules from sidecar/package-lock.json before a release build (`npm run build:release`,
// tauri.conf.json beforeBuildCommand), so a local `npm run tauri build` bundles exactly what CI bundles.
// If node_modules is a symlink (an isolated source snapshot, e.g. scripts/updater-smoke.py, links the real
// checkout's copy), it is left alone: `npm ci` would otherwise delete and rewrite the linked checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sidecar = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sidecar');
const modules = path.join(sidecar, 'node_modules');
let linked = false;
try {
  linked = fs.lstatSync(modules).isSymbolicLink();
} catch {}
if (linked) {
  console.log(`sidecar: ${modules} is a symlink, skipping npm ci (using the linked install as is)`);
} else {
  execSync('npm ci --no-audit --no-fund', { cwd: sidecar, stdio: 'inherit' });
}
