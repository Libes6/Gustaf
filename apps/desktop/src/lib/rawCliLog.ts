import { rawLog } from "./api";
import { redactSecrets, redactValue } from "./exportChats";

// Debugging aid, switched OFF: the app no longer collects raw CLI events and has no UI for it, and a `recordRawCliEvents`
// value saved by an earlier build is ignored (see `rawLogEnabled`). The logger itself stays for a future debug switch: it
// appends every stdout line of codex / claude / cursor-agent, before any parsing, to a bounded file under the app data
// folder (src-tauri/src/rawlog.rs keeps one file per day and at most 5 MB in total), scrubbed with the chat export's secret scrubber.

export const RAW_LOG_SETTING = "recordRawCliEvents";
/** One entry is clipped to this many characters (the rest of a huge line is of no use for debugging). */
export const MAX_ENTRY_CHARS = 64 * 1024;
const FLUSH_MS = 400;

/** Always false for now: nothing is recorded, whatever an old build saved under `RAW_LOG_SETTING`. */
export const rawLogEnabled = (): Promise<boolean> => Promise.resolve(false);

const two = (n: number) => String(n).padStart(2, "0");
/** Local calendar day, the name of the day's file. */
export const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

type Entry = { t: number; provider: string; chat: number | null } & ({ line: string } | { debug: string; data?: Record<string, unknown> });

/** Pure: one JSON line (no newline). A line that is JSON is stored as an object, anything else as text; secrets are scrubbed. */
export function rawLogLine(e: Entry): string {
  const head = { t: new Date(e.t).toISOString(), provider: e.provider, chat: e.chat };
  let body: Record<string, unknown>;
  if ("debug" in e) body = { debug: e.debug, ...(e.data ? { data: redactValue(e.data) } : {}) };
  else {
    let event: unknown;
    try { event = JSON.parse(e.line); } catch { /* a banner or a warning */ }
    body = event !== undefined && event !== null && typeof event === "object" ? { event: redactValue(event) } : { text: redactSecrets(e.line) };
  }
  const out = JSON.stringify({ ...head, ...body });
  return out.length <= MAX_ENTRY_CHARS ? out : JSON.stringify({ ...head, truncated: out.length, text: out.slice(0, MAX_ENTRY_CHARS) });
}

export type RawLogger = {
  /** A stdout line exactly as the CLI printed it. */
  raw(line: string): void;
  /** A debug note (kept in the same file). */
  debug(kind: string, data?: Record<string, unknown>): void;
  /** An item that looked like a subagent event but fell back to the generic card (providers/activities.ts). */
  unmapped(info: Record<string, unknown>): void;
  flush(): Promise<void>;
};

const NOOP: RawLogger = { raw() {}, debug() {}, unmapped() {}, async flush() {} };

/** Buffers lines and appends them in batches; writing never throws into the chat run. `enabled` false returns a no-op logger. */
export function createRawLogger(enabled: boolean, provider: string, chat: number | null, sink: (day: string, lines: string) => Promise<unknown> = rawLog.append, now: () => number = Date.now): RawLogger {
  if (!enabled) return NOOP;
  let buffer: { day: string; line: string }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unmapped = 0;
  let chain: Promise<unknown> = Promise.resolve();
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    const batch = buffer;
    buffer = [];
    const days = [...new Set(batch.map((b) => b.day))];
    for (const day of days) {
      const lines = batch.filter((b) => b.day === day).map((b) => `${b.line}\n`).join("");
      chain = chain.then(() => sink(day, lines)).catch(() => {});
    }
    return chain.then(() => {});
  };
  const push = (e: Entry) => {
    try { buffer.push({ day: dayOf(e.t), line: rawLogLine(e) }); } catch { return; }
    if (buffer.length >= 200) void flush();
    else timer ??= setTimeout(() => void flush(), FLUSH_MS);
  };
  return {
    raw: (line) => push({ t: now(), provider, chat, line }),
    debug: (debug, data) => push({ t: now(), provider, chat, debug, data }),
    unmapped(info) {
      unmapped++;
      push({ t: now(), provider, chat, debug: "unmapped-collab-item", data: info });
    },
    flush() {
      if (unmapped) { push({ t: now(), provider, chat, debug: "unmapped-total", data: { count: unmapped } }); unmapped = 0; }
      return flush();
    },
  };
}
