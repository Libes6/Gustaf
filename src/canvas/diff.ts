/** Small pure line diff (Myers O(ND)) used to compare canvas revisions. */
import type { ArtifactFile } from "./modules.ts";

export type DiffLine = { kind: "same" | "add" | "del"; text: string; oldNo?: number; newNo?: number };
export type DiffRow = DiffLine | { kind: "skip"; count: number };
export type FileDiff = { name: string; status: "added" | "removed" | "modified" | "unchanged"; lines: DiffLine[]; added: number; removed: number };

/** Edit-distance ceiling; beyond it the middle section is reported as a plain replacement instead of a minimal diff. */
const MAX_EDITS = 1000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Returns the edit script for the middle part as a list of ops, or null when it is too different. */
function myers(a: string[], b: string[]): ("same" | "add" | "del")[] | null {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const limit = Math.min(max, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
  }
  if (found < 0) return null;
  const ops: ("same" | "add" | "del")[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push("same"); x--; y--; }
    ops.push(down ? "add" : "del");
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) { ops.push("same"); x--; y--; }
  return ops.reverse();
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before), b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA), midB = b.slice(start, endB);
  const ops = myers(midA, midB) ?? [...midA.map(() => "del" as const), ...midB.map(() => "add" as const)];
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  const push = (kind: DiffLine["kind"], text: string) => {
    out.push({ kind, text, ...(kind !== "add" ? { oldNo: ++i } : {}), ...(kind !== "del" ? { newNo: ++j } : {}) });
  };
  for (let k = 0; k < start; k++) push("same", a[k]);
  let ai = 0, bi = 0;
  for (const op of ops) {
    if (op === "same") { push("same", midA[ai]); ai++; bi++; }
    else if (op === "del") push("del", midA[ai++]);
    else push("add", midB[bi++]);
  }
  for (let k = endA; k < a.length; k++) push("same", a[k]);
  return out;
}

/** Per-file diff of two revisions: files are matched by name; new files first in the newer order, removed files last. */
export function diffFiles(before: ArtifactFile[], after: ArtifactFile[]): FileDiff[] {
  const old = new Map(before.map((f) => [f.name, f.code]));
  const names = [...after.map((f) => f.name), ...before.map((f) => f.name).filter((n) => !after.some((f) => f.name === n))];
  const next = new Map(after.map((f) => [f.name, f.code]));
  return names.map((name) => {
    const had = old.has(name), has = next.has(name);
    const lines = diffLines(old.get(name) ?? "", next.get(name) ?? "");
    const added = lines.filter((l) => l.kind === "add").length;
    const removed = lines.filter((l) => l.kind === "del").length;
    const status = !had ? "added" : !has ? "removed" : added || removed ? "modified" : "unchanged";
    return { name, status, lines, added, removed };
  });
}

/** Keeps changed lines plus `context` neighbours; runs of other unchanged lines become one skip row. */
export function collapseContext(lines: DiffLine[], context = 3): DiffRow[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === "same") return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) { if (skipped) rows.push({ kind: "skip", count: skipped }); skipped = 0; rows.push(l); } else skipped++;
  });
  if (skipped) rows.push({ kind: "skip", count: skipped });
  return rows;
}
