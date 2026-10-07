// Settings, Diagnostics: pure helpers (node-testable). Process rows come from the Rust `process_snapshot` command, which
// only returns the app's own process tree; everything shown is scrubbed here with the chat-export secret scrubber.
import { redactSecrets } from "./exportChats.ts";
import type { ProviderHealth } from "./providerDiagnostics.ts";

export type ProcInfo = {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  elapsedSecs: number;
  command: string;
  isApp: boolean;
};

/** A process this busy is flagged so a runaway agent stands out. */
export const HEAVY_CPU = 80;
export const HEAVY_RSS_KB = 1.5 * 1024 * 1024;
export const MAX_TEXT = 300;

// `--token abc123`, `-p secret` style flags: the generic scrubber only knows `key=value` and `key: value`.
const FLAG_VALUE =
  /(--?(?:api[_-]?key|token|secret|passw(?:or)?d|passwd|authorization|access[_-]?key|auth)[\w-]*)(\s+)(?!-)\S{4,}/gi;

/** Hides secrets in free text (command lines, error messages) and bounds its length. */
export function scrubText(text: string, max = MAX_TEXT): string {
  const out = redactSecrets(text.replace(FLAG_VALUE, (_, flag: string, space: string) => `${flag}${space}[REDACTED]`))
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const RUNNERS = /^(node|nodejs|python3?|bun|deno|npx|tsx|ruby|sh|bash|zsh)$/;

/** Short name for a process: the program, plus the script for interpreters (`node index.mjs`). Scrubbed. */
export function processName(command: string): string {
  const [first = "", second = ""] = command.trim().split(/\s+/);
  const name = base(first);
  return scrubText(
    RUNNERS.test(name) && second && !second.startsWith("-") ? `${name} ${base(second)}` : name || "?",
    80,
  );
}

export const isHeavy = (p: ProcInfo) => p.cpu >= HEAVY_CPU || p.rssKb >= HEAVY_RSS_KB;

export function formatMemory(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}

export function formatUptime(secs: number): string {
  if (secs >= 86_400) return `${Math.floor(secs / 86_400)}d ${Math.floor((secs % 86_400) / 3600)}h`;
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m`;
  return `${secs}s`;
}

export function totals(list: ProcInfo[]) {
  return {
    count: list.length,
    rssKb: list.reduce((a, p) => a + p.rssKb, 0),
    cpu: Math.round(list.reduce((a, p) => a + p.cpu, 0)),
  };
}

export type DiagError = { id: string; source: string; text: string; at?: number };

/**
 * Recent errors from data the app already has: provider checks (error and sign-in statuses), model listing and limit
 * errors, MCP server errors. Newest first when timestamps exist; text is scrubbed and bounded.
 */
export function collectErrors(o: {
  providers: { id: string; name: string }[];
  health: Record<string, ProviderHealth | undefined>;
  modelErrors: Record<string, string | undefined>;
  limitErrors: Record<string, string | undefined>;
  mcp: { id: string; state: string; error: string | null }[];
  limit?: number;
}): DiagError[] {
  const out: DiagError[] = [];
  const name = (id: string) => o.providers.find((p) => p.id === id)?.name ?? id;
  for (const [id, h] of Object.entries(o.health))
    if (h && h.status !== "ok" && h.message)
      out.push({ id: `health:${id}`, source: name(id), text: scrubText(h.message), at: h.at });
  for (const [id, m] of Object.entries(o.modelErrors))
    if (m && !(o.health[id]?.status === "error" && o.health[id]?.message === m))
      out.push({ id: `models:${id}`, source: name(id), text: scrubText(m) });
  for (const [id, m] of Object.entries(o.limitErrors))
    if (m) out.push({ id: `limits:${id}`, source: name(id), text: scrubText(m) });
  for (const s of o.mcp)
    if (s.error) out.push({ id: `mcp:${s.id}`, source: `MCP ${scrubText(s.id, 60)}`, text: scrubText(s.error) });
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, o.limit ?? 20);
}
