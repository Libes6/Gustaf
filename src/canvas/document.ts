import runtime from "./generated/runtime.js?raw";

export function canvasDocument(code: string): string {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const payload = JSON.stringify({ code }).replace(/</g, "\\u003c");
  // Only our bundled bootstrap can start scripts; generated code executes inside this opaque frame.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{min-height:100%;margin:0}body{font:15px/1.5 system-ui;background:#faf9fc;color:#24212b}*{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}</style>
</head><body><div id="root"></div><script id="canvas-source" type="application/json">${payload}</script><script nonce="${nonce}">${runtime.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
