import { cmdKey } from "./shortcuts.ts";
// Pure helpers for the Cmd+K search palette (no Tauri/DOM/React imports, so node tests can cover them).
// The index and the query escaping live in src-tauri/src/db.rs; this file only deals with what comes back.

/** Delimiters db.rs wraps around matches in a snippet (`MARK_OPEN` / `MARK_CLOSE` there). */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";
/** Shorter queries are not searched: one letter matches (as a prefix) most of the history. */
export const MIN_QUERY_CHARS = 2;
/** Hits requested per search; the palette says so when a search returns this many. */
export const RESULT_LIMIT = 40;
/** A pending jump older than this is dropped (the chat never became visible). */
export const JUMP_TTL_MS = 10_000;

/** Ask the chat view to scroll to a message once the chat is open (`seq` distinguishes repeated requests). */
export type Jump = { chatId: number; messageId: number; seq: number };

export type SnippetPart = { text: string; hit: boolean };

/**
 * Splits a snippet from the backend into plain and highlighted runs. Whitespace (including the newlines of the
 * original message) is collapsed, so the result renders on one wrapped line. Unbalanced markers are tolerated.
 */
export function parseSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  let buf = "";
  const flush = () => {
    const text = buf.replace(/\s+/g, " ");
    buf = "";
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text;
    else parts.push({ text, hit });
  };
  for (const ch of snippet) {
    if (ch === MARK_OPEN) (flush(), (hit = true));
    else if (ch === MARK_CLOSE) (flush(), (hit = false));
    else buf += ch;
  }
  flush();
  if (parts.length) {
    parts[0].text = parts[0].text.trimStart();
    parts[parts.length - 1].text = parts[parts.length - 1].text.trimEnd();
  }
  return parts.filter((p) => p.text);
}

/** The text to search for, or null while the input is too short or has no letters or digits. */
export function searchableQuery(input: string): string | null {
  const q = input.trim();
  return [...q].length >= MIN_QUERY_CHARS && /[\p{L}\p{N}]/u.test(q) ? q : null;
}

/** Next highlighted row for an arrow key, wrapping around at both ends. */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  if (current < 0 || current >= count) return delta >= 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}

/**
 * The message to scroll to: the matched one, or, when it no longer exists (rewound, deleted), the closest earlier
 * message, else the closest later one. Null for an empty chat.
 */
export function nearestMessageId(ids: readonly number[], target: number): number | null {
  let before: number | null = null;
  let after: number | null = null;
  for (const id of ids) {
    if (id === target) return id;
    if (id < target) before = before === null || id > before ? id : before;
    else after = after === null || id < after ? id : after;
  }
  return before ?? after;
}

/** Whether a chat turn (user message plus the reply steps) contains the message. */
export function turnHasMessage(turn: { user?: { id: number }; steps: readonly { id: number }[] }, id: number): boolean {
  return turn.user?.id === id || turn.steps.some((s) => s.id === id);
}

type KeyLike = { key: string; code?: string; metaKey: boolean; ctrlKey?: boolean; shiftKey: boolean; altKey: boolean };

/**
 * Cmd+K. `code` is checked as well as `key` so the shortcut also works on a Russian layout (where `key` is "л").
 * Ctrl is not accepted on macOS (Ctrl+K is "delete to end of line" in text fields); on Windows and Linux Ctrl is the main key.
 */
export function isSearchShortcut(e: KeyLike): boolean {
  return cmdKey(e) && !e.shiftKey && !e.altKey && (e.code === "KeyK" || e.key.toLowerCase() === "k");
}
