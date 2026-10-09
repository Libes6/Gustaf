// Turns what the helper reports about an action into the text of an ActionResult. Pure, no I/O.

import type { HelperSettle } from "./helperOutput";
import { describeNode, diffMaps, renderDiff, type UiMap } from "./uiMap";

/** The helper's own diff lines (`data.settle.diff.lines`), compacted: removed/added/changed with a cap. Fallback only. */
export function helperDiffText(settle: HelperSettle | undefined, max = 30): string {
  const lines = Array.isArray(settle?.diff?.lines) ? settle.diff.lines : [];
  if (!lines.length) return "";
  const sign = (k?: string) => (k === "added" ? "+" : k === "removed" ? "-" : "~");
  const body = lines
    .filter((l) => typeof l.text === "string")
    .map((l) => `${sign(l.kind)} ${l.text!.replace(/\s/g, " ")}`);
  const s = settle?.diff?.summary;
  const head = s ? `${s.removals ?? 0} removed, ${s.additions ?? 0} added, ${s.unchanged ?? 0} unchanged` : "changed";
  const shown = body.slice(0, max);
  if (body.length > max) shown.push(`… ${body.length - max} more changes`);
  return `${head}\n${shown.join("\n")}`;
}

/**
 * What changed between two maps of the same device, as text; empty when nothing did. When the whole screen was
 * replaced (a new page, another app) only the new elements are listed: the old ones are no use to the reader.
 */
export function mapDiffText(before: UiMap, after: UiMap): string {
  const d = diffMaps(before, after);
  const changes = d.removed.length + d.added.length;
  if (changes <= 20 || d.unchanged * 3 >= d.removed.length) return renderDiff(d);
  const shown = d.added.slice(0, 40).map((n) => `+ ${describeNode(n)}`);
  if (d.added.length > 40) shown.push(`… ${d.added.length - 40} more elements`);
  return `The screen changed: ${d.removed.length} elements gone, ${d.added.length} new\n${shown.join("\n")}`;
}
