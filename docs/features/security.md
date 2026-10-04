# Webview security: CSP and capabilities

Policy lives in `src-tauri/tauri.conf.json` (`app.security.csp` for release builds, `devCsp` for `tauri dev`) and `src-tauri/capabilities/default.json`. `tests/csp.test.mjs` (`npm run test:csp`, also part of `npm test`) pins both.

## Where the webview loads things from

App JS and CSS come from the Vite bundle (`'self'`; the lazy chunks are `CanvasPanel` and the raw canvas runtimes used by the HTML export). Icons are `public/icons/*.svg`. Images are `data:` URLs (attachments, tool screenshots) and `blob:`. There are no web fonts and no remote images. The webview does no network I/O itself: `providers/http.ts` re-exports the http plugin's `fetch`, which is IPC (`ipc:` and `http://ipc.localhost`, hence `connect-src`). There is no `WebSocket`, `EventSource` or worker (the test greps for them). In `tauri dev`, Vite adds an inline React-refresh module script and the HMR websocket on `ws://localhost:1420`; only `devCsp` allows these.

Tauri rewrites HTML assets: it adds nonces to `<style>` and `script[src^=http]` tags and hashes of inline scripts and styles to `script-src` / `style-src`, but only when such tags exist. The Vite `index.html` has none, so the policy applies as written. `dangerousDisableAssetCspModification` must stay off (the test checks it). On macOS the CSP is sent as a response header for HTML assets.

## Release CSP

`default-src 'self'`; `script-src 'self' 'unsafe-eval'`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`; `font-src 'self' data:`; `connect-src 'self' ipc: http://ipc.localhost`; `frame-src about:`; `object-src 'none'`; `base-uri` and `form-action` `'self'`. Remote images in Markdown (`![](https://...)`) are no longer fetched, which also closes an exfiltration channel; add `https:` to `img-src` to allow them again.

## Canvas versus the parent CSP

The preview is `<iframe sandbox="allow-scripts" srcDoc=...>`. A `srcdoc` document (like `about:blank` and `blob:`) inherits its creator's policy container, so the app's CSP and the canvas document's own meta CSP are both enforced and everything it does must pass both. Consequences:

1. The previous nonce'd inline bootstrap cannot run: the app's `script-src` has no such nonce, and a hash would change on every build. The preview now loads the runtime with `<script nonce=... src="/canvas/runtime.js">` (or `runtime-icons.js` for sources importing `lucide-react`), allowed by the parent's `'self'` and the frame's nonce. `scripts/build-canvas.mjs` writes them to `public/canvas/`. The standalone HTML export still inlines the runtime (`canvasExportDocument`, loaded lazily), since an exported file has no app CSP around it.
2. `new Function` in `canvas/runtime.tsx` needs `'unsafe-eval'` in the parent `script-src`.
3. The preview document's `<style>` and `style=` need `'unsafe-inline'` in the parent `style-src`, and `img-src` / `font-src` must include `data:` / `blob:`.

Avoiding inheritance would mean serving the canvas from a real origin that is not CSP-inherited, for example a custom URI scheme registered in Rust (`register_uri_scheme_protocol`, with per-platform URL forms and a message channel to hand the code over). That cannot be verified without a running Tauri app, so the parent policy carries the canvas's needs instead; `'unsafe-eval'` is the cost. The test shows it is only for the canvas: the app's own chunks contain no `eval` / `new Function`, the sandbox flags (`allow-scripts` only, opaque origin), the frame's `default-src 'none'` / `connect-src 'none'` and the absence of an app API over `postMessage` are asserted, and a headless Chrome run confirms that the frame renders, can eval, cannot fetch or read the parent, and that an inline script is refused under the inherited policy.

## Capabilities

Only permissions the frontend calls are granted: dialog open/save/message, notification notify (plus permission check/request), opener default URLs, reveal in Finder and the System Settings deep link, global shortcut register/unregister, window drag/maximize/badge/attention, shell spawn/execute/stdin/kill, http fetch. Window show/hide/set-focus were dropped because `computer.rs` hides and shows the window from Rust, which capabilities do not gate.

`http:default` scope: `https://*` (with and without a port) plus plain `http://` only for loopback, single-label hosts, RFC 1918 ranges (10/8, 172.16/12, 192.168/16), link-local, Tailscale CGNAT (100.64/10) and the `.local`, `.lan`, `.internal`, `.home.arpa`, `.ts.net` suffixes. Ollama, LM Studio and LAN or Tailscale servers keep working, and an API key cannot be sent in clear text to a public host; a custom endpoint (including an MCP HTTP server) on a public host must use https. The patterns use hostname regex groups and were checked against the `urlpattern` crate that `tauri-plugin-http` uses: `192.168.*.*` would be wrong because `*` also matches `evil.com`, and groups cannot nest, so 172.16/12 and 100.64/10 are split into several entries.

The MCP OAuth sign-in (`docs/features/mcp.md`) needs nothing more: its discovery, registration and token requests are plugin-http requests to https authorization servers (or loopback http), covered by this scope, the browser is opened through `opener:allow-default-urls`, and the redirect is received by a Rust command, not by the webview. The sign-in refuses plain-http authorization endpoints even where the scope would allow them (private ranges). `tests/csp.test.mjs` pins representative OAuth endpoint URLs as allowed and public http as not. The OAuth redirect URI string `http://127.0.0.1:<port>/callback` appears in the bundle, which is why `127.0.0.1` is in the test's known-hosts list; the webview never loads it.

Shell scope: `args` is `["-lc", {"validator": "(?s).+"}]` for `spawn` and `execute`, matching every `Command.create("zsh", ["-lc", script])` call site, so other flags and extra arguments are rejected. The script itself is free-form on purpose: agents run user-approved shell commands, so the real gate is the approval flow and command rules (`agent/rules.ts`), not the Tauri scope.

## Verification

`npm run test:csp` checks the policy against an allow-list per directive, builds the frontend into a temp dir and scans it (no inline scripts or handlers, no `eval`, no unknown external hosts, no remote CSS), checks the capability file, and, when Chrome is installed (`CHROME_BIN` to override), serves the build with the CSP header and drives it over the DevTools protocol. Not covered: real WKWebView behaviour inside Tauri (Chrome implements the same CSP3 inheritance rules, but is not the same engine).

`npm run test:e2e` (see [ARCHITECTURE](../ARCHITECTURE.md#conventions)) also loads the production build under this CSP in Chrome and fails any scenario that logs a console error or a CSP violation, covering onboarding, chat, search, approvals, canvas and every settings page.

After changing the CSP, run once in `npm run tauri dev` (dev policy) and in a debug build (`npm run tauri build -- --debug --bundles app`, release policy):

- open a canvas card: Preview renders, Code tab, Restart, Export HTML;
- send a message, attach an image (thumbnail and sent message show it);
- open every Settings page, press Cmd+K;
- look for "Refused to ..." in the web inspector console.

To switch the CSP off temporarily, set `"csp": null` (and remove `devCsp`) under `app.security` in `src-tauri/tauri.conf.json`.

The quick-ask window (`docs/features/quick-ask.md`) has its own capability file `capabilities/quick-ask.json`: events (listen, unlisten, emit-to), window dragging and the same `http:default` scope. Showing, hiding and resizing it are Rust commands, so it holds no shell, dialog, opener, notification or global-shortcut permission. `tests/csp.test.mjs` pins the list.
