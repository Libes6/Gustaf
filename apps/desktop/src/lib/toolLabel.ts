// How a tool call is described in the chat: what kind of action it is, the short target to show next to the verb
// ("git status", "TASKS.md", a skill name) and how consecutive calls are folded into one summary.
// Pure functions, no React, so the formatting is unit-testable.

export type ToolKind = "command" | "read" | "list" | "search" | "edit" | "write" | "skill" | "web" | "mcp" | "computer" | "unknown";

type CallLike = { name: string; args?: any; computer?: unknown };

const KINDS: Record<string, ToolKind> = {
  run_command: "command", shell: "command", bash: "command", command_execution: "command", terminal: "command",
  read_file: "read", read: "read", readfile: "read",
  list_dir: "list", ls: "list", glob: "list", list: "list",
  search: "search", grep: "search", codebase_search: "search", semsearch: "search",
  edit_file: "edit", edit: "edit", multiedit: "edit", file_change: "edit", strreplace: "edit", str_replace: "edit", apply_patch: "edit",
  write_file: "write", write: "write",
  skill: "skill",
  web_fetch: "web", webfetch: "web", web_search: "web", websearch: "web", fetch_url: "web",
  mcp_tool_call: "mcp",
};

export const toolKind = (call: CallLike): ToolKind => (call.computer ? "computer" : KINDS[call.name.toLowerCase()] ?? "unknown");

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The command without the `cd "<project root>" &&` the agent puts in front of every call. Only a `cd` into the project
 * root itself is dropped (any absolute path when the root is unknown); a `cd` somewhere else is information and stays.
 */
export function stripCd(command: string, projectRoot?: string): string {
  const m = /^\s*cd\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*(?:&&|;)\s*/.exec(command);
  if (!m) return command;
  const dir = (m[1] ?? m[2] ?? m[3]).replace(/\/+$/, "");
  const root = projectRoot?.replace(/\/+$/, "");
  const rest = command.slice(m[0].length);
  if (!rest.trim()) return command;
  return (root ? dir === root : dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)) ? rest : command;
}

/** A path relative to the project root when it lies inside it. */
export function shortPath(path: string, projectRoot?: string): string {
  const root = projectRoot?.replace(/\/+$/, "");
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path;
}

/** The text that follows the verb of a call's row. Empty for unknown tools (their JSON is only in the expanded body). */
export function toolTarget(call: CallLike, projectRoot?: string): string {
  const a = call.args ?? {};
  switch (toolKind(call)) {
    case "command": return oneLine(stripCd(str(a.command), projectRoot));
    case "read": case "edit": case "write": return shortPath(str(a.file_path) || str(a.path) || str(a.target_file), projectRoot);
    case "list": return shortPath(str(a.path) || str(a.target_directory) || str(a.pattern) || str(a.glob_pattern) || ".", projectRoot);
    case "search": return oneLine(str(a.pattern) || str(a.query) || str(a.regex));
    case "skill": return str(a.skill) || str(a.name) || str(a.command);
    case "web": return str(a.url) || str(a.query);
    case "mcp": return [str(a.server), str(a.tool)].filter(Boolean).join(" · ");
    default: return "";
  }
}

/** The full, untruncated text of a row for its tooltip (multi-line commands keep their line breaks). */
export function toolFullText(call: CallLike, projectRoot?: string): string {
  return toolKind(call) === "command" ? stripCd(str(call.args?.command), projectRoot).trim() : toolTarget(call, projectRoot);
}

/** Buckets of a group summary ("Ran 6 commands · 2 files read"); everything that is not one of the first four is "other". */
export type GroupBucket = "command" | "read" | "edit" | "search" | "other";
export const GROUP_ORDER: GroupBucket[] = ["command", "read", "edit", "search", "other"];

const BUCKET: Partial<Record<ToolKind, GroupBucket>> = { command: "command", read: "read", edit: "edit", write: "edit", search: "search", list: "search", web: "search" };

export function groupCounts(calls: CallLike[]): Partial<Record<GroupBucket, number>> {
  const out: Partial<Record<GroupBucket, number>> = {};
  for (const c of calls) {
    const b = BUCKET[toolKind(c)] ?? "other";
    out[b] = (out[b] ?? 0) + 1;
  }
  return out;
}

/** Splits `items` into runs: consecutive items for which `isTool` holds become one `{ tools }` entry, the rest stay single. */
export function groupRuns<T>(items: readonly T[], isTool: (item: T) => boolean): ({ tools: T[] } | { item: T })[] {
  const out: ({ tools: T[] } | { item: T })[] = [];
  for (const item of items) {
    const last = out[out.length - 1];
    if (!isTool(item)) out.push({ item });
    else if (last && "tools" in last) last.tools.push(item);
    else out.push({ tools: [item] });
  }
  return out;
}
