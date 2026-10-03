import { buildCanvasDocument, needsIcons } from "./documentBuilder.ts";

/** Static copies of the runtimes (public/canvas/, written by scripts/build-canvas.mjs) that the preview iframe loads. */
export const CANVAS_RUNTIME_URL = "/canvas/runtime.js";
export const CANVAS_ICONS_RUNTIME_URL = "/canvas/runtime-icons.js";

/**
 * Preview document for the sandboxed iframe (srcdoc). A srcdoc document inherits the app's CSP, which has no nonce for an
 * inline script, so the bootstrap is an external script (allowed by the app's 'self' and by this document's nonce). The app
 * policy must also allow 'unsafe-eval' (generated code runs through `new Function`) and inline styles; see docs/features/security.md.
 */
export function canvasDocument(code: string): string {
  return buildCanvasDocument(code, "", { runtimeUrl: CANVAS_RUNTIME_URL, iconsRuntimeUrl: CANVAS_ICONS_RUNTIME_URL });
}

/** Self-contained HTML for the export (runtime inlined; it has no app CSP around it). The runtimes load lazily, only on export. */
export async function canvasExportDocument(code: string, title: string): Promise<string> {
  const { default: runtime } = await import("./generated/runtime.js?raw");
  const iconsRuntime = needsIcons(code) ? (await import("./generated/runtime-icons.js?raw")).default : undefined;
  return buildCanvasDocument(code, runtime, { title, iconsRuntime });
}
