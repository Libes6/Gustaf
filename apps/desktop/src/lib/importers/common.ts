// Shared pieces of the history importers (Claude Code, Codex CLI, ChatGPT). Pure: no Tauri, no SQLite, no React, so the
// parsers run under plain Node in tests/importers.test.mjs. Only conversation text is imported; every string goes
// through the same secret scrubber the chat export uses.
import type { Msg, Part } from "../../providers/types.ts";
import { redactSecrets, redactValue } from "../exportChats.ts";

export type ImportSource = "claude-code" | "codex" | "chatgpt";
export const SOURCE_LABELS: Record<ImportSource | "cursor", string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
};

/** Bounds applied while parsing; whatever is larger is clipped with a visible marker, never silently dropped. */
export const LIMITS = {
  /** One JSONL line longer than this is skipped (the Rust reader skips longer lines too). */
  line: 4 * 1024 * 1024,
  /** Characters kept of one text part. */
  text: 200_000,
  /** Characters kept of one tool output. */
  output: 100_000,
  /** Characters kept of one string inside tool arguments. */
  arg: 50_000,
  /** Messages kept per chat. */
  messages: 10_000,
  title: 120,
};

export type ImportedMessage = { role: Msg["role"]; parts: Part[]; createdAt?: number; meta?: NonNullable<Msg["meta"]> };
export type ImportedChat = {
  source: ImportSource;
  /** Id of the session or conversation in its source; with the source name it forms the stored `source_id`. */
  sourceId: string;
  title: string;
  createdAt?: number;
  updatedAt?: number;
  /** Directory the session ran in. It only names/matches a project; it is never registered as an accessible folder. */
  project: { name: string; path: string | null } | null;
  messages: ImportedMessage[];
  /** Number of malformed or oversized input lines that were skipped. */
  skippedLines: number;
  /** Messages beyond `LIMITS.messages` were dropped. */
  clipped: boolean;
};

export const storedSourceId = (source: ImportSource, id: string) => `${source}:${id}`;

export const rec = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): v is string => typeof v === "string";

export function clipText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[truncated ${s.length - max} characters]`;
}

/** Scrubbed, size-bounded text for a message part. */
export const cleanText = (s: string, max = LIMITS.text) => redactSecrets(clipText(s, max));

/** Deep copy of tool arguments with secrets scrubbed and long strings clipped. */
export function cleanArgs(value: unknown, depth = 0): any {
  if (str(value)) return redactSecrets(clipText(value, LIMITS.arg));
  if (depth > 12) return "[nested too deep]";
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => cleanArgs(v, depth + 1));
  if (rec(value)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) if (k !== "__proto__") out[k] = cleanArgs(v, depth + 1);
    return redactValue(out);
  }
  return value;
}

export const titleFrom = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, LIMITS.title);

/** Milliseconds from an ISO string, epoch seconds (ChatGPT) or milliseconds; undefined for anything unusable. */
export function toMs(v: unknown, unit: "iso" | "seconds" = "iso"): number | undefined {
  if (str(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = unit === "seconds" ? Math.round(v * 1000) : Math.round(v);
    return ms <= 8.64e15 ? ms : undefined;
  }
  return undefined;
}

export const baseName = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || path;

export function projectOf(cwd: unknown): ImportedChat["project"] {
  if (!str(cwd) || !cwd.trim()) return null;
  return { name: baseName(cwd.trim()).slice(0, 200), path: cwd.trim() };
}

/** Calls `each` for every non-empty line of `text`; lines over the limit are reported through `onSkip` unread. */
export function eachLine(text: string, each: (line: string) => void, onSkip: () => void, max = LIMITS.line) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    if (end - pos > max) onSkip();
    else {
      const line = text.slice(pos, end).trim();
      if (line) each(line);
    }
    pos = end + 1;
  }
}

/** Parses one JSON line; anything that is not an object is a malformed line. */
export function parseLine(line: string): Record<string, any> | null {
  try {
    const v = JSON.parse(line);
    return rec(v) ? v : null;
  } catch {
    return null;
  }
}

/** Text of a tool result that may be a string, a list of content blocks or an object. */
export function outputText(v: unknown): string {
  if (str(v)) return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        str(b) ? b : rec(b) ? (str(b.text) ? b.text : /image/.test(String(b.type)) ? "[image omitted]" : "") : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  if (rec(v)) {
    if (str(v.output)) return v.output;
    if (str(v.text)) return v.text;
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return v == null ? "" : String(v);
}

/** Output of the placeholder result added for a tool call that has no recorded result. */
export const NO_RESULT = "[no result was recorded]";

/**
 * Makes the tool structure valid for every provider: each assistant `tool_call` is followed by one `tool` message holding
 * a result for every call (a placeholder when the session recorded none), and results without a call are dropped.
 */
export function pairTools(messages: ImportedMessage[]): ImportedMessage[] {
  const out: ImportedMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "tool") {
      i++; // orphan results (no call right before them) are dropped
      continue;
    }
    out.push(m);
    i++;
    const calls =
      m.role === "assistant"
        ? m.parts.filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call")
        : [];
    if (!calls.length) continue;
    const results = new Map<string, Extract<Part, { type: "tool_result" }>>();
    let at = messages[i]?.createdAt;
    while (i < messages.length && messages[i].role === "tool") {
      at = messages[i].createdAt ?? at;
      for (const p of messages[i].parts) if (p.type === "tool_result" && !results.has(p.id)) results.set(p.id, p);
      i++;
    }
    const parts: Part[] = calls.map(
      (c) => results.get(c.id) ?? { type: "tool_result", id: c.id, name: c.name, output: NO_RESULT, isError: true },
    );
    out.push({ role: "tool", parts, createdAt: at ?? m.createdAt });
  }
  return out;
}

/** Applies the message cap after pairing so a cut never separates a call from its results. */
export function capMessages(messages: ImportedMessage[]): { messages: ImportedMessage[]; clipped: boolean } {
  if (messages.length <= LIMITS.messages) return { messages, clipped: false };
  let end = LIMITS.messages;
  while (end > 0 && messages[end - 1].role !== "tool" && messages[end - 1].parts.some((p) => p.type === "tool_call"))
    end--;
  return { messages: messages.slice(0, end), clipped: true };
}
