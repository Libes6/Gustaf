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

A finished block becomes a card. Opening it displays Result and Code tabs, restart, copy, and a version selector. Reuse an `id` and send the full module to create a revision. Versions are derived from stored assistant messages, so no separate artifact database is needed. Unclosed fences cannot be opened. Runtime and syntax errors offer a button that puts a repair request and the source into the composer; the user sends it normally.

Canvas instructions are included in API system prompts and CLI prompts, including resumed sessions. Only `react` imports are supported. Use inline styles, a `<style>` element, and SVG; Tailwind and other packages are not included.

React and Sucrase are bundled locally by `scripts/build-canvas.mjs` during `predev` and `prebuild`. The canvas panel is lazy-loaded. Generated files in `src/canvas/generated` are ignored by Git; no CDN is required.

Preview code is compiled and executed inside an opaque-origin iframe with only `allow-scripts`. CSP blocks fetch, external subresources, nested frames, forms, and objects. There is no application API exposed through messages; the parent only accepts bounded error text from the active iframe. The sandbox is a browser boundary, not a CPU/memory quota: a pathological infinite loop can still make the renderer unresponsive. Native WebView isolation should also be verified on release builds.

## Verification

```sh
npm run test:canvas
node scripts/check-i18n.mjs
npm run build
```

With `npm run dev` running, `/tests/canvas.html` is a development-only integration fixture using the real Markdown, canvas panel and sandbox runtime. It covers hooks and TypeScript, revisions, incomplete streams, runtime/syntax errors, script-tag escaping and parent/storage/fetch isolation. The fixture is not a production entry point.
