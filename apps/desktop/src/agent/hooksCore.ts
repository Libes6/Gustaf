// Hooks: user-defined commands on agent lifecycle events (docs/features/hooks.md). This file is pure (no Tauri, no React):
// schema validation, matcher semantics, the stdin payload and how a hook's exit code and output are interpreted.
// Node runs it directly in tests/hooks.test.mjs; the runtime that executes hooks is hooks.ts.

export const HOOK_EVENTS = ["pre_tool", "post_tool", "post_edit", "stop", "approval_request"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookSource = "global" | "project";

export type Hook = { event: HookEvent; matcher: string; command: string; timeoutMs: number; source: HookSource };
/** A rejected entry (`index` is its position in the file's `hooks` array, null for the file as a whole). */
export type HookIssue = { source: HookSource; index: number | null; message: string };
export type HooksConfig = { hooks: Hook[]; issues: HookIssue[] };

export const GLOBAL_HOOKS_SETTING = "hooks";
export const PROJECT_HOOKS_SETTING = "hooksProjects";
export const PROJECT_HOOKS_FILE = ".gustaf/hooks.json";
export const MAX_HOOKS = 20;
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
export const MIN_HOOK_TIMEOUT_MS = 100;
export const MAX_HOOK_TIMEOUT_MS = 60_000;
export const MAX_HOOK_COMMAND = 2_000;
export const MAX_HOOK_MATCHER = 200;
/** A hooks.json larger than this is ignored as a whole. */
export const MAX_HOOKS_FILE_BYTES = 64 * 1024;
/** Output of a hook that is appended to a tool result or sent to the model. */
export const MAX_HOOK_OUTPUT = 2048;
/** Tool input in the stdin payload. */
export const MAX_PAYLOAD_INPUT = 4000;
export const MAX_PAYLOAD_RESULT = 1000;
/** Exit code that blocks a tool call (pre_tool) or sends the output back to the model (stop). */
export const HOOK_BLOCK_CODE = 2;

const EVENT_SET: readonly string[] = HOOK_EVENTS;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** Validates the parsed content of a hooks file. Invalid entries are skipped and reported; nothing here throws. */
export function validateHooks(raw: unknown, source: HookSource): HooksConfig {
  const hooks: Hook[] = [];
  const issues: HookIssue[] = [];
  const issue = (index: number | null, message: string) => issues.push({ source, index, message });
  const list = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { hooks?: unknown }).hooks : undefined;
  if (!Array.isArray(list)) {
    issue(null, 'The file must be a JSON object with a "hooks" array.');
    return { hooks, issues };
  }
  list.forEach((item, i) => {
    if (i >= MAX_HOOKS) {
      if (i === MAX_HOOKS) issue(i, `Only the first ${MAX_HOOKS} hooks are used; the rest are ignored.`);
      return;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) return issue(i, "A hook must be an object.");
    const h = item as Record<string, unknown>;
    if (typeof h.event !== "string" || !EVENT_SET.includes(h.event)) return issue(i, `"event" must be one of: ${HOOK_EVENTS.join(", ")}.`);
    if (typeof h.command !== "string" || !h.command.trim()) return issue(i, '"command" must be a non-empty string.');
    if (h.command.length > MAX_HOOK_COMMAND) return issue(i, `"command" is longer than ${MAX_HOOK_COMMAND} characters.`);
    if (h.matcher !== undefined && typeof h.matcher !== "string") return issue(i, '"matcher" must be a string.');
    const matcher = (h.matcher ?? "*") as string;
    if (matcher.length > MAX_HOOK_MATCHER) return issue(i, `"matcher" is longer than ${MAX_HOOK_MATCHER} characters.`);
    let timeoutMs = DEFAULT_HOOK_TIMEOUT_MS;
    if (h.timeoutMs !== undefined) {
      if (typeof h.timeoutMs !== "number" || !Number.isInteger(h.timeoutMs) || h.timeoutMs < MIN_HOOK_TIMEOUT_MS || h.timeoutMs > MAX_HOOK_TIMEOUT_MS)
        return issue(i, `"timeoutMs" must be a whole number between ${MIN_HOOK_TIMEOUT_MS} and ${MAX_HOOK_TIMEOUT_MS}.`);
      timeoutMs = h.timeoutMs;
    }
    hooks.push({ event: h.event as HookEvent, matcher: matcher.trim() || "*", command: h.command.trim(), timeoutMs, source });
  });
  return { hooks, issues };
}

/** Removes the `   12|` line numbers `fs_read` puts in front of every line. */
export const stripLineNumbers = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\|/, ""))
    .join("\n");

/** Parses the text of a hooks file (as read through `fsx.read`, line numbers included or not). */
export function parseHooksText(text: string, source: HookSource): HooksConfig {
  if (text.length > MAX_HOOKS_FILE_BYTES) return { hooks: [], issues: [{ source, index: null, message: `The file is larger than ${MAX_HOOKS_FILE_BYTES / 1024} KB and was ignored.` }] };
  let raw: unknown;
  const plain = /^\s*\d+\|/.test(text) ? stripLineNumbers(text) : text;
  try {
    raw = JSON.parse(plain);
  } catch (e) {
    return { hooks: [], issues: [{ source, index: null, message: `Invalid JSON: ${String((e as Error)?.message ?? e)}` }] };
  }
  return validateHooks(raw, source);
}

/**
 * Matcher semantics: alternatives separated by `|`, each a glob (`*` any run of characters, `?` one character) that must
 * match the whole tool name, case-sensitive. An empty matcher or `*` matches everything.
 */
export function matchesTool(matcher: string, name: string): boolean {
  const parts = matcher.split("|").map((p) => p.trim());
  return parts.some((p) => {
    if (!p || p === "*") return true;
    const re = new RegExp("^" + p.replace(/[.+^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    return re.test(name);
  });
}

/** Hooks of `event` whose matcher fits `tool` (stop hooks ignore the matcher). */
export const hooksFor = (hooks: readonly Hook[], event: HookEvent, tool = "") => hooks.filter((h) => h.event === event && (event === "stop" || matchesTool(h.matcher, tool)));

/** Global hooks first, then the project's when the user enabled them for it. */
export function effectiveHooks(global: HooksConfig, project: HooksConfig, projectEnabled: boolean): Hook[] {
  return [...global.hooks, ...(projectEnabled ? project.hooks : [])];
}

/** Tool input for the stdin payload: long strings are cut and the whole is capped. */
export function truncateInput(input: unknown): unknown {
  const cut = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return clip(v, 500);
    if (Array.isArray(v)) return depth > 3 ? "…" : v.slice(0, 20).map((x) => cut(x, depth + 1));
    if (v && typeof v === "object") return depth > 3 ? "…" : Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, cut(x, depth + 1)]));
    return v;
  };
  const small = cut(input ?? {}, 0);
  const text = JSON.stringify(small);
  return text.length > MAX_PAYLOAD_INPUT ? { truncated: true, preview: text.slice(0, MAX_PAYLOAD_INPUT) } : small;
}

export type HookPayloadInput = { event: HookEvent; tool?: string; input?: unknown; root: string; project: string | null; chatId?: number; result?: string; isError?: boolean };

/** The JSON document a hook reads on stdin. */
export function buildPayload(p: HookPayloadInput): string {
  return JSON.stringify({
    event: p.event,
    tool: p.tool ?? null,
    input: truncateInput(p.input),
    project: p.project ?? p.root,
    root: p.root,
    chatId: p.chatId ?? null,
    ...(p.result !== undefined ? { result: clip(p.result, MAX_PAYLOAD_RESULT) } : {}),
    ...(p.isError ? { isError: true } : {}),
  });
}

/** The three variables a hook gets (besides the minimal shell environment). */
export const hookEnv = (event: HookEvent, tool: string | undefined, project: string): Record<string, string> => ({ GUSTAF_EVENT: event, GUSTAF_TOOL: tool ?? "", GUSTAF_PROJECT: project });

export type HookExit = { code: number | null; output: string; timedOut: boolean };

export const hookText = (output: string, max = MAX_HOOK_OUTPUT) => {
  const t = output.trim();
  return t.length > max ? t.slice(0, max) + "\n[hook output truncated]" : t;
};

/** Log status of a finished hook: exit 2 is a normal answer for pre_tool and stop, any other non-zero code or a timeout is a failure. */
export function hookStatus(event: HookEvent, r: HookExit): "success" | "error" {
  if (r.timedOut || r.code === null) return "error";
  if (r.code === 0) return "success";
  return r.code === HOOK_BLOCK_CODE && (event === "pre_tool" || event === "stop") ? "success" : "error";
}

/** pre_tool: exit 2 blocks (the text goes back to the model as the tool result); everything else never blocks. */
export function preToolVerdict(r: HookExit): { blocked: false } | { blocked: true; message: string } {
  if (!r.timedOut && r.code === HOOK_BLOCK_CODE) return { blocked: true, message: `blocked by hook: ${hookText(r.output) || "no reason given"}` };
  return { blocked: false };
}

/** post_tool / post_edit: text appended to the tool result. Exit 0 with output is appended as is, a failure as a warning. */
export function postToolAddendum(command: string, r: HookExit): string {
  const text = hookText(r.output);
  if (r.timedOut) return `\n\n[hook warning: "${command}" timed out]${text ? "\n" + text : ""}`;
  if (r.code === 0) return text ? `\n\n[hook output: ${command}]\n${text}` : "";
  return `\n\n[hook warning: "${command}" exited with code ${r.code ?? "killed"}]${text ? "\n" + text : ""}`;
}

/** stop: exit 2 asks the agent to continue; the text becomes a follow-up user message. */
export function stopFollowUp(command: string, r: HookExit): string | null {
  if (r.timedOut || r.code !== HOOK_BLOCK_CODE) return null;
  return `A stop hook ("${command}") asked you to continue:\n${hookText(r.output) || "no details given"}`;
}
