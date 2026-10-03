/** Where the bundled canvas runtime is served from (public/canvas/runtime.js, built by scripts/build-canvas.mjs). */
export const CANVAS_RUNTIME_URL = "/canvas/runtime.js";

/** The CSP of the canvas document itself. It is combined with (never replaces) the app's CSP, see below. */
export const canvasCsp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

export function canvasDocument(code: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payload = JSON.stringify({ code }).replace(/</g, "\\u003c");
  // A srcdoc iframe inherits the parent's CSP and both policies must allow everything it does. The app's CSP has no
  // nonce for an inline script, so the bootstrap is an external script (allowed by the parent's 'self' and by the
  // nonce here) instead of an inline one; the parent also has to allow 'unsafe-eval' and inline styles for this frame.
  // Generated code executes inside the opaque-origin sandbox (sandbox="allow-scripts" without allow-same-origin).
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${canvasCsp(nonce)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{min-height:100%;margin:0}body{font:15px/1.5 system-ui;background:#faf9fc;color:#24212b}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}</style>
</head><body><div id="root"></div><script id="canvas-source" type="application/json">${payload}</script><script nonce="${nonce}" src="${CANVAS_RUNTIME_URL}"></script></body></html>`;
}
