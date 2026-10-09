// The interface map of a device screen: the platform's accessibility tree, normalised into one shape. It drives three
// things: the inspector in the Device panel (element under the pointer), the tree shown next to the screen, and the
// text an agent reads instead of guessing pixels. Pure, no I/O. The input is the `nodes` of an `agent-device snapshot`
// (https://www.npmjs.com/package/agent-device, the helper T3 Code also uses); fixtures in tests/fixtures are real
// output from an iOS 26.2 simulator.

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

export type UiNode = {
  /** Position in `UiMap.nodes`; parents come before children. */
  index: number;
  /** The helper's reference for this node ("e7"); valid only for the snapshot it came from. */
  ref: string;
  /** Normalised kind: "cell", "button", "navigation-bar", "image", "other"... */
  role: string;
  label?: string;
  id?: string;
  value?: string;
  placeholder?: string;
  rect: Rect;
  enabled: boolean;
  /** The element can receive a tap at its centre. */
  hittable: boolean;
  /** Something covers it ("covered"): a tap would land elsewhere. */
  blocked?: string;
  depth: number;
  parent: number | null;
  children: number[];
};

export type UiMap = {
  app?: { name?: string; bundleId?: string };
  viewport: Size;
  nodes: UiNode[];
  /** The helper stopped at its node limit. */
  truncated: boolean;
  /** Changes whenever the helper reissues refs. */
  generation?: number;
};

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.replace(/\u00a0/g, " ").trim() : undefined);
const asRect = (v: unknown): Rect => {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { x: num(r.x), y: num(r.y), width: Math.max(0, num(r.width)), height: Math.max(0, num(r.height)) };
};

/** Parses the `data` of a snapshot. Unknown or malformed input gives an empty map, never throws. */
export function parseSnapshot(data: unknown): UiMap {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const raw: unknown[] = Array.isArray(d.nodes) ? d.nodes : [];
  const nodes: UiNode[] = [];
  // The helper's `index` / `parentIndex` refer to the raw list; keep a map in case entries are skipped.
  const at = new Map<number, number>();
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") return;
    const n = entry as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const ref = text(n.ref);
    if (!ref) return;
    const rawIndex = typeof n.index === "number" ? n.index : i;
    const parentRaw = typeof n.parentIndex === "number" ? at.get(n.parentIndex) : undefined;
    const node: UiNode = {
      index: nodes.length,
      ref,
      role: text(n.kind) ?? text(n.role)?.toLowerCase() ?? text(n.type)?.toLowerCase() ?? "other",
      label: text(n.label),
      id: text(n.identifier),
      value: text(n.value),
      placeholder: text(n.placeholder),
      rect: asRect(n.rect),
      enabled: n.enabled !== false,
      hittable: n.hittable === true,
      blocked: text(n.interactionBlocked),
      depth: Math.max(0, num(n.depth)),
      parent: parentRaw ?? null,
      children: [],
    };
    at.set(rawIndex, node.index);
    if (node.parent !== null) nodes[node.parent].children.push(node.index);
    nodes.push(node);
  });
  const vp = (d.viewport && typeof d.viewport === "object" ? d.viewport : {}) as Record<string, unknown>;
  const root = nodes[0]?.rect;
  return {
    app: { name: text(d.appName), bundleId: text(d.appBundleId) },
    viewport: {
      width: num(vp.width) || root?.width || 0,
      height: num(vp.height) || root?.height || 0,
    },
    nodes,
    truncated: d.truncated === true,
    generation: typeof d.refsGeneration === "number" ? d.refsGeneration : undefined,
  };
}

const ACTIONABLE = new Set([
  "button",
  "cell",
  "link",
  "switch",
  "checkbox",
  "radio",
  "tab",
  "menu-item",
  "search",
  "text-field",
  "secure-text-field",
  "slider",
  "stepper",
  "picker",
  "segmented-control",
  "textfield",
  "text-view",
]);

/** True for elements an agent can usefully act on. */
export const isInteractive = (n: UiNode) => n.enabled && n.hittable && !n.blocked && ACTIONABLE.has(n.role);

export const contains = (r: Rect, p: { x: number; y: number }) =>
  p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;

const area = (r: Rect) => r.width * r.height;

/**
 * The element a tap at `point` (device points) would reach: the deepest node under it, later siblings (drawn on top)
 * before earlier ones, covered nodes only when nothing else is there. A node whose own rect fills the screen is the
 * answer only when nothing smaller contains the point.
 */
export function hitTest(map: UiMap, point: { x: number; y: number }): UiNode | null {
  let best: UiNode | null = null;
  const better = (a: UiNode, b: UiNode) => {
    if (!!a.blocked !== !!b.blocked) return !a.blocked;
    if (a.depth !== b.depth) return a.depth > b.depth;
    if (area(a.rect) !== area(b.rect)) return area(a.rect) < area(b.rect);
    return a.index > b.index;
  };
  for (const n of map.nodes) {
    if (n.rect.width <= 0 || n.rect.height <= 0 || !contains(n.rect, point)) continue;
    if (!best || better(n, best)) best = n;
  }
  return best;
}

/** Ancestors of a node, nearest first. */
export function ancestors(map: UiMap, n: UiNode): UiNode[] {
  const out: UiNode[] = [];
  for (let p = n.parent; p !== null; p = map.nodes[p].parent) out.push(map.nodes[p]);
  return out;
}

/** Case-insensitive search over label, id, value, role and ref. */
export function findNodes(map: UiMap, query: string): UiNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return map.nodes.filter((n) =>
    [n.label, n.id, n.value, n.placeholder, n.role, n.ref].some((s) => s?.toLowerCase().includes(q)),
  );
}

export const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

// ---- screen geometry: device points <-> the box the screen is drawn in ----

/** The rectangle (inside `box`) the device screen is drawn in when it keeps its aspect ratio. */
export function fitScreen(device: Size, box: Size): Rect {
  if (device.width <= 0 || device.height <= 0 || box.width <= 0 || box.height <= 0)
    return { x: 0, y: 0, width: 0, height: 0 };
  const scale = Math.min(box.width / device.width, box.height / device.height);
  const width = device.width * scale;
  const height = device.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** A point in the box to a device point, clamped to the screen; null outside the drawn screen. */
export function viewToDevice(device: Size, shown: Rect, p: { x: number; y: number }) {
  if (shown.width <= 0 || !contains(shown, p)) return null;
  return {
    x: Math.min(device.width - 1e-6, ((p.x - shown.x) / shown.width) * device.width),
    y: Math.min(device.height - 1e-6, ((p.y - shown.y) / shown.height) * device.height),
  };
}

export function deviceToView(device: Size, shown: Rect, r: Rect): Rect {
  const sx = device.width > 0 ? shown.width / device.width : 0;
  const sy = device.height > 0 ? shown.height / device.height : 0;
  return { x: shown.x + r.x * sx, y: shown.y + r.y * sy, width: r.width * sx, height: r.height * sy };
}

// ---- text for agents and people ----

const quote = (s: string, max = 80) => JSON.stringify(s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** One line: `@e7 [cell] "General" id=com.apple.settings.general value="1" (disabled)`. */
export function describeNode(n: UiNode): string {
  const parts = [`@${n.ref}`, `[${n.role}]`];
  if (n.label) parts.push(quote(n.label));
  if (n.id && n.id !== n.label) parts.push(`id=${n.id}`);
  if (n.value && n.value !== n.label) parts.push(`value=${quote(n.value, 40)}`);
  else if (n.placeholder && !n.label) parts.push(`placeholder=${quote(n.placeholder, 40)}`);
  if (!n.enabled) parts.push("(disabled)");
  if (n.blocked) parts.push(`(${n.blocked})`);
  return parts.join(" ");
}

const offscreen = (n: UiNode, v: Size) =>
  v.width > 0 &&
  (n.rect.x >= v.width || n.rect.y >= v.height || n.rect.x + n.rect.width <= 0 || n.rect.y + n.rect.height <= 0);

/** Nodes worth showing: named or actionable, on screen, not an exact duplicate of an earlier one. */
export function visibleNodes(map: UiMap): UiNode[] {
  const seen = new Set<string>();
  return map.nodes.filter((n) => {
    if (offscreen(n, map.viewport) || n.rect.width <= 0 || n.rect.height <= 0) return false;
    if (!n.label && !n.id && !n.value && !n.placeholder && !isInteractive(n)) return false;
    const key = [
      n.role,
      n.label,
      n.id,
      n.value,
      Math.round(n.rect.x),
      Math.round(n.rect.y),
      Math.round(n.rect.width),
      Math.round(n.rect.height),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The map as text for an agent: a header, then the visible elements indented by depth (indent counts only the shown
 * ancestors), actionable ones first in tree order. At most `maxLines` lines; the rest is counted.
 */
export function renderMap(map: UiMap, o: { maxLines?: number } = {}): string {
  const max = o.maxLines ?? 120;
  const shown = visibleNodes(map);
  const keep = new Set(shown.map((n) => n.index));
  const level = (n: UiNode) => ancestors(map, n).filter((a) => keep.has(a.index)).length;
  const head = `${map.app?.name ?? "App"}${map.app?.bundleId ? ` (${map.app.bundleId})` : ""} ${Math.round(map.viewport.width)}x${Math.round(map.viewport.height)}`;
  const lines = shown.map((n) => `${"  ".repeat(level(n))}${describeNode(n)}`);
  const hidden = map.nodes.length - shown.length;
  const out = [head, ...lines.slice(0, max)];
  if (lines.length > max) out.push(`… ${lines.length - max} more elements`);
  if (hidden > 0) out.push(`(${hidden} unnamed, hidden or off-screen elements not shown)`);
  if (map.truncated) out.push("(the snapshot was cut at the helper's element limit)");
  return out.join("\n");
}

// ---- what changed between two snapshots ----

export type MapDiff = {
  added: UiNode[];
  removed: UiNode[];
  changed: { before: UiNode; after: UiNode }[];
  unchanged: number;
};

const signature = (n: UiNode) => `${n.role}|${n.id ?? ""}|${n.label ?? ""}`;

/** Compares by role, id and label (refs are reissued per snapshot); equal signatures pair up in order. */
export function diffMaps(before: UiMap, after: UiMap): MapDiff {
  const pool = new Map<string, UiNode[]>();
  for (const n of visibleNodes(before)) pool.set(signature(n), [...(pool.get(signature(n)) ?? []), n]);
  const diff: MapDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const n of visibleNodes(after)) {
    const list = pool.get(signature(n));
    const old = list?.shift();
    if (!old) diff.added.push(n);
    else if (old.value !== n.value || old.enabled !== n.enabled || old.blocked !== n.blocked)
      diff.changed.push({ before: old, after: n });
    else diff.unchanged++;
  }
  for (const list of pool.values()) diff.removed.push(...list);
  return diff;
}

/** The diff as text; empty when nothing changed. */
export function renderDiff(d: MapDiff, o: { maxLines?: number } = {}): string {
  const max = o.maxLines ?? 40;
  const lines = [
    ...d.removed.map((n) => `- ${describeNode(n)}`),
    ...d.added.map((n) => `+ ${describeNode(n)}`),
    ...d.changed.map(
      (c) => `~ ${describeNode(c.after)} (was ${c.before.value ? quote(c.before.value, 40) : "no value"})`,
    ),
  ];
  if (!lines.length) return "";
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`… ${lines.length - max} more changes`);
  return `${d.removed.length} removed, ${d.added.length} added, ${d.changed.length} changed, ${d.unchanged} unchanged\n${shown.join("\n")}`;
}
