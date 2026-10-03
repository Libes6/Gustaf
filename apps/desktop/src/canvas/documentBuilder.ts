/** Builds the self-contained canvas HTML document. Pure (the runtime source is passed in) so Node tests can import it. */
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Sources that import lucide-react get the larger runtime that bundles the icons (see scripts/build-canvas.mjs). */
export const needsIcons = (code: string) => /["']lucide-react["']/.test(code);

/** The canvas document's own CSP. Inside the app it is combined with the app's CSP (a srcdoc iframe inherits it). */
export const canvasCsp = (nonce: string) =>
  `default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

/**
 * `runtimeUrl`/`iconsRuntimeUrl` (preview in the app): the bootstrap is an external nonce'd script instead of an inline one,
 * because the app's CSP has no nonce for inline scripts. Without them (standalone export) the runtime source is inlined.
 */
export function buildCanvasDocument(code: string, runtime: string, options: { title?: string; nonce?: string; iconsRuntime?: string; runtimeUrl?: string; iconsRuntimeUrl?: string } = {}): string {
  if (options.iconsRuntime && needsIcons(code)) runtime = options.iconsRuntime;
  const nonce = options.nonce ?? crypto.randomUUID().replace(/-/g, "");
  const payload = JSON.stringify({ code }).replace(/</g, "\\u003c");
  const title = options.title ? `<title>${escapeHtml(options.title.slice(0, 160))}</title>\n` : "";
  const url = options.runtimeUrl && (needsIcons(code) && options.iconsRuntimeUrl ? options.iconsRuntimeUrl : options.runtimeUrl);
  const bootstrap = url ? `<script nonce="${nonce}" src="${url}"></script>` : `<script nonce="${nonce}">${runtime.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--")}</script>`;
  // Only our bundled bootstrap can start scripts; generated code executes inside this opaque frame.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${canvasCsp(nonce)}">
<meta name="viewport" content="width=device-width,initial-scale=1">
${title}<style>html,body,#root{min-height:100%;margin:0}body{font:15px/1.5 system-ui;background:#faf9fc;color:#24212b}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}</style>
</head><body><div id="root"></div><script id="canvas-source" type="application/json">${payload}</script>${bootstrap}</body></html>`;
}
