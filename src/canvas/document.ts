import runtime from "./generated/runtime.js?raw";
import { buildCanvasDocument } from "./documentBuilder.ts";

/** Preview document for the sandboxed iframe; with a title it is also the standalone HTML export. */
export function canvasDocument(code: string, title?: string): string {
  return buildCanvasDocument(code, runtime, { title });
}
