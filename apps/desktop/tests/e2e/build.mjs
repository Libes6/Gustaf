import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** Production build of the frontend (canvas runtimes first, then `vite build`) into `outDir`. */
export function buildFrontend(outDir) {
  execFileSync(process.execPath, ['scripts/build-canvas.mjs'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: root, stdio: 'pipe' });
}
