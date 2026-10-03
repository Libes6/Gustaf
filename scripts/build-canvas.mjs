import { build } from 'esbuild';
import { resolve } from 'node:path';

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
