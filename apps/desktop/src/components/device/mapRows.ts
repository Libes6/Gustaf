// The rows of the interface-map tree: which nodes to show, how deep to indent them, search and the "interactive only"
// filter. Pure.

import { findNodes, isInteractive, visibleNodes, type UiMap, type UiNode } from "../../device/uiMap";

export type MapRow = { node: UiNode; level: number; actionable: boolean };

export function mapRows(map: UiMap, o: { query?: string; interactiveOnly?: boolean } = {}): MapRow[] {
  const shown = visibleNodes(map);
  const keep = new Set(shown.map((n) => n.index));
  const matches = o.query?.trim() ? new Set(findNodes(map, o.query).map((n) => n.index)) : null;
  const level = (n: UiNode) => {
    let depth = 0;
    for (let p = n.parent; p !== null; p = map.nodes[p].parent) if (keep.has(p)) depth++;
    return depth;
  };
  return shown
    .filter((n) => (!matches || matches.has(n.index)) && (!o.interactiveOnly || isInteractive(n)))
    .map((node) => ({ node, level: level(node), actionable: isInteractive(node) }));
}

/** The text a row shows for a node. */
export const nodeTitle = (n: UiNode) => n.label ?? n.id ?? n.value ?? n.placeholder ?? "";

/**
 * Finds the node a pinned element became after the map was refreshed (refs are reissued per snapshot): same role,
 * id and label, the closest one when there are several. Null when it is gone or has nothing to be recognised by.
 */
export function rematchNode(map: UiMap, old: UiNode): UiNode | null {
  if (!old.id && !old.label) return null;
  let best: UiNode | null = null;
  let bestDistance = Infinity;
  for (const n of map.nodes) {
    if (n.role !== old.role || n.id !== old.id || n.label !== old.label) continue;
    const d = Math.hypot(n.rect.x - old.rect.x, n.rect.y - old.rect.y);
    if (d < bestDistance) {
      best = n;
      bestDistance = d;
    }
  }
  return best;
}
