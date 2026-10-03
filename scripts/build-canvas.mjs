import { build } from 'esbuild';
// The runtime is a static asset (public/canvas/runtime.js -> dist/canvas/runtime.js), loaded by the canvas
// iframe with <script src>. It cannot be inlined: a srcdoc iframe inherits the app's CSP, which has no
// nonce/hash for an inline script (see src/canvas/document.ts and docs/ARCHITECTURE.md, "Security").
await build({
  entryPoints: ['src/canvas/runtime.tsx'], outfile: 'public/canvas/runtime.js',
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: ['safari16'],
  define: { 'process.env.NODE_ENV': '"production"' },
});
