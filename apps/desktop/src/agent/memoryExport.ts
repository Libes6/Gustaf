// "Export to AGENTS.md": pure rendering of the managed section and the marker merge (no Tauri, no React), unit-tested in
// tests/memoryExport.test.mjs. Only the text between the markers is ever replaced; everything else in the file is kept byte
// for byte, and a file whose markers cannot be trusted (a missing end, a duplicate) is refused instead of guessed at.
import { redactSecrets } from "../lib/exportChats.ts";

export const MARKER_START = "<!-- gustaf-memory:start -->";
export const MARKER_END = "<!-- gustaf-memory:end -->";
export const AGENTS_FILE = "AGENTS.md";

export type ExportCode = "malformed" | "unreadable" | "truncated";
export class MemoryExportError extends Error {
  code: ExportCode;
  constructor(code: ExportCode, message: string) { super(message); this.name = "MemoryExportError"; this.code = code; }
}

/** One fact as Markdown list lines: markers and HTML comment delimiters are neutralised, secrets scrubbed, blank lines dropped. */
function bullet(text: string): string {
  const lines = redactSecrets(text)
    .replace(/\r\n?/g, "\n")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  return lines.map((l, i) => (i === 0 ? `- ${l.trim()}` : `  ${l.trim()}`)).join("\n");
}

/** Oldest first, so editing one fact does not reshuffle the file. */
const stable = (e: { id: number; text: string }[]) => [...e].sort((a, b) => a.id - b.id).filter((x) => x.text.trim());

/**
 * The managed block (always `\n` newlines, from the start marker to the end marker). Project facts first; global facts only
 * when the caller passes them (the user ticked "include global").
 */
export function renderSection(project: { id: number; text: string }[], global: { id: number; text: string }[] = []): string {
  const out = [
    MARKER_START,
    "## Project memory",
    "",
    "_Managed by Gustaf (Settings → Memory → Export to AGENTS.md). Text between these markers is replaced on the next export; keep your own notes outside them._",
  ];
  const p = stable(project);
  const g = stable(global);
  if (p.length) out.push("", ...p.map((x) => bullet(x.text)));
  if (g.length) out.push("", "### Global preferences", "", ...g.map((x) => bullet(x.text)));
  out.push(MARKER_END);
  return out.join("\n");
}

export type MergeAction = "create" | "append" | "update" | "unchanged";

const count = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * The file text after exporting `section`: created when the file is missing (`existing` is null), appended after the
 * existing content when it has no markers yet, or the section between the markers replaced. Surrounding text and the file's
 * line endings are preserved, and merging the same section again changes nothing. Throws `malformed` unless the file has
 * either no markers at all or exactly one start marker followed by exactly one end marker.
 */
export function mergeSection(existing: string | null, section: string): { text: string; action: MergeAction } {
  const eol = existing !== null && existing.includes("\r\n") ? "\r\n" : "\n";
  const body = section.replace(/\r?\n/g, eol);
  if (existing === null) return { text: body + eol, action: "create" };
  const starts = count(existing, MARKER_START);
  const ends = count(existing, MARKER_END);
  if (starts === 0 && ends === 0) {
    if (!existing.trim()) return { text: body + eol, action: "append" };
    const lead = existing.endsWith(eol + eol) ? "" : existing.endsWith("\n") ? eol : eol + eol;
    return { text: existing + lead + body + eol, action: "append" };
  }
  const s = existing.indexOf(MARKER_START);
  const e = existing.indexOf(MARKER_END);
  if (starts !== 1 || ends !== 1 || e < s) {
    throw new MemoryExportError("malformed", "AGENTS.md has unbalanced or duplicate gustaf-memory markers");
  }
  const text = existing.slice(0, s) + body + existing.slice(e + MARKER_END.length);
  return { text, action: text === existing ? "unchanged" : "update" };
}

export type InstructionRead = { name: string; bytes: number; text: string };

/**
 * What is currently in `<project>/AGENTS.md`, from the instruction-file reader (capped, lossy UTF-8) and a directory listing:
 * `null` when the file really is absent. A file that exists but was not read back faithfully (cut at the read cap, invalid
 * UTF-8, a directory, a link out of the project) is refused, because writing over it would lose content.
 */
export function currentAgentsMd(files: InstructionRead[], listing: string): string | null {
  const hit = files.find((f) => f.name === AGENTS_FILE);
  if (!hit) {
    if (listing.split("\n").some((n) => n === AGENTS_FILE || n === `${AGENTS_FILE}/`)) {
      throw new MemoryExportError("unreadable", "AGENTS.md exists but could not be read");
    }
    return null;
  }
  if (new TextEncoder().encode(hit.text).length !== hit.bytes) {
    throw new MemoryExportError(hit.text.includes("�") ? "unreadable" : "truncated", "AGENTS.md could not be read back completely");
  }
  return hit.text;
}
