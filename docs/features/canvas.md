# Interactive canvas

Part of the [M Code documentation](../README.md).

Assistant messages can contain a complete React/TSX module:

````text
```tsx-canvas id="counter" title="Counter"
import { useState } from "react";
export default function Counter() {
  const [count, setCount] = useState<number>(0);
  return <button onClick={() => setCount(count + 1)}>Count: {count}</button>;
}
```
````

A finished block becomes a card. Opening it displays Result, Code and Changes tabs, restart, copy, download, export as HTML, and a version selector. Reuse an `id` and send the full module to create a revision. Versions are derived from stored assistant messages, so no separate artifact database is needed. Unclosed fences cannot be opened. Runtime and syntax errors offer a button that puts a repair request and the source into the composer; the user sends it normally.

Canvas instructions are included in API system prompts and CLI prompts, including resumed sessions. Supported imports: `react`, `lucide-react` (icons) and relative imports between the artifact's own files. Use inline styles, a `<style>` element, and SVG; Tailwind and other packages are not included.

## Multiple files

One fence can hold several files. If the first non-blank line of the body is `// file: <path>`, every such line starts a new file; otherwise the body is a single `App.tsx`:

````text
```tsx-canvas id="app" title="App"
// file: App.tsx
import { total } from "./lib/math";
export default function App() { return <p>{total([1, 2, 3])}</p>; }
// file: lib/math.ts
export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
```
````

The first file is the entry and default-exports the component. Paths are relative (`a/b.ts`, extensions `tsx ts jsx js`, at most 24 files, no `..`); imports between files resolve with or without the extension and to `index.*` files. Imports of anything other than `react`, `lucide-react` and the artifact's own files fail with an error naming the file and import; a missing file lists the available ones. Import cycles do not loop or crash (the cyclic module sees its partially filled exports, as in CommonJS). Compilation errors name the file. The Code tab shows one tab per file; copy and download act on the selected file. Every revision repeats all files; revisions keep them.

## Changes (revision diff)

The Changes tab (shown when an artifact has more than one revision) compares two selectable versions, by default the current one with the one before. It is a unified line diff per file (files matched by name; added and removed files are listed), with 3 lines of context and collapsed unchanged runs. The diff is a small pure Myers implementation in `src/canvas/diff.ts`; for extremely different files (more than 1000 edits in the changed middle part) it degrades to a plain replace.

## Export

- Export as HTML (the file-code button) saves a standalone `.html` through the native save dialog (a download in the browser). It is the preview document itself: the same CSP meta (no network, no external subresources), the bundled runtime and the TSX source (all files) inlined; the runtime compiles the source when the file is opened, so there is nothing to fetch. It runs without the iframe sandbox when opened directly in a browser, but the CSP still blocks connections.
- Export as PNG is deliberately not offered: the preview lives in an opaque-origin sandboxed iframe, so a screenshot would need an extra parent-to-iframe message channel plus an SVG `foreignObject` snapshot drawn on a canvas, which taints the canvas (and fails) in WebKit/WKWebView, the engine of the macOS app, and would need inlining of computed styles. It could not be made reliable and safe without new dependencies.

## Icons (`lucide-react`)

`import { Heart } from "lucide-react"` works in canvas sources. `scripts/build-canvas.mjs` builds two runtimes: `runtime.js` (about 430 KB) and `runtime-icons.js` (about 1.29 MB, all icons); the document builder (`src/canvas/documentBuilder.ts`) inlines the larger one only when the source mentions `"lucide-react"`, so other artifacts and their exports keep the small size. Nothing is fetched at runtime.

React and Sucrase are bundled locally by `scripts/build-canvas.mjs` during `predev` and `prebuild`. The canvas panel is lazy-loaded. Generated files in `src/canvas/generated` are ignored by Git; no CDN is required.

Preview code is compiled and executed inside an opaque-origin iframe with only `allow-scripts`. CSP blocks fetch, external subresources, nested frames, forms, and objects. There is no application API exposed through messages; the parent only accepts bounded error text from the active iframe. The sandbox is a browser boundary, not a CPU/memory quota: a pathological infinite loop can still make the renderer unresponsive. Native WebView isolation should also be verified on release builds.

## Verification

```sh
npm run test:canvas
node scripts/check-i18n.mjs
npm run build
```

With `npm run dev` running, `/tests/canvas.html` is a development-only integration fixture using the real Markdown, canvas panel and sandbox runtime. It covers hooks and TypeScript, revisions (the Changes tab), multi-file artifacts with icons,  incomplete streams, runtime/syntax errors, script-tag escaping and parent/storage/fetch isolation. The fixture is not a production entry point.
