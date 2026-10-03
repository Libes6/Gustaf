import { build } from 'esbuild';
import { resolve } from 'node:path';
import { copyFileSync, mkdirSync } from 'node:fs';

const common = {
  entryPoints: ['src/canvas/runtime.tsx'],
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['safari16'],
  define: { 'process.env.NODE_ENV': '"production"' },
};
await build({ ...common, outfile: 'src/canvas/generated/runtime.js' });
// Second bundle with lucide-react icons; the document loader only inlines it for sources that import "lucide-react".
await build({
  ...common, outfile: 'src/canvas/generated/runtime-icons.js',
  plugins: [{
    name: 'canvas-icons',
    setup(b) { b.onResolve({ filter: /^\.\/icons\.ts$/ }, () => ({ path: resolve('src/canvas/icons-lucide.ts') })); },
  }],
});
// The preview iframe loads these as static assets (public/canvas/*.js -> /canvas/*.js) with <script src>: a srcdoc
// iframe inherits the app's CSP, which has no nonce/hash for an inline script (see src/canvas/document.ts and
// docs/features/security.md). The generated/ copies stay for the standalone HTML export, which inlines them.
mkdirSync('public/canvas', { recursive: true });
for (const name of ['runtime.js', 'runtime-icons.js']) copyFileSync(`src/canvas/generated/${name}`, `public/canvas/${name}`);
