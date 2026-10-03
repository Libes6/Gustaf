import { build } from 'esbuild';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyFileSync, mkdirSync } from 'node:fs';

// Paths are resolved from the app directory (apps/desktop), not the working directory, so the script runs from anywhere.
const root = fileURLToPath(new URL('..', import.meta.url));
const common = {
  entryPoints: [join(root, 'src/canvas/runtime.tsx')],
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['safari16'],
  define: { 'process.env.NODE_ENV': '"production"' },
};
await build({ ...common, outfile: join(root, 'src/canvas/generated/runtime.js') });
// Second bundle with lucide-react icons; the document loader only inlines it for sources that import "lucide-react".
await build({
  ...common, outfile: join(root, 'src/canvas/generated/runtime-icons.js'),
  plugins: [{
    name: 'canvas-icons',
    setup(b) { b.onResolve({ filter: /^\.\/icons\.ts$/ }, () => ({ path: resolve(root, 'src/canvas/icons-lucide.ts') })); },
  }],
});
// The preview iframe loads these as static assets (public/canvas/*.js -> /canvas/*.js) with <script src>: a srcdoc
// iframe inherits the app's CSP, which has no nonce/hash for an inline script (see src/canvas/document.ts and
// docs/features/security.md). The generated/ copies stay for the standalone HTML export, which inlines them.
mkdirSync(join(root, 'public/canvas'), { recursive: true });
for (const name of ['runtime.js', 'runtime-icons.js']) copyFileSync(join(root, 'src/canvas/generated', name), join(root, 'public/canvas', name));
