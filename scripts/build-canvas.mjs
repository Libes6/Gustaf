import { build } from 'esbuild';
await build({
  entryPoints: ['src/canvas/runtime.tsx'], outfile: 'src/canvas/generated/runtime.js',
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['safari16'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
