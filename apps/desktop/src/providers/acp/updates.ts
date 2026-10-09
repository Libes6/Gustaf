// Maps ACP `session/update` notifications to what Gustaf shows. Pure: no Tauri, no I/O. The agent is untrusted, so every
// field is read defensively, text is bounded and unknown update kinds are ignored. Tool-call vocabulary follows the ACP
// spec (agentclientprotocol.com/protocol/tool-calls); the native Antigravity argument names (`CommandLine`...) come
// from T3 Code's AntigravityProtocol (MIT, github.com/pingdotgg/t3code).
import { isRecord, type Json } from "./rpc.ts";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";
export type ToolCard = {
  id: string;
  name: string;
  args: Record<string, string>;
  status: "running" | "success" | "error";
  output?: string;
};
export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed"; priority?: string };

export type UpdateEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | { type: "tool"; card: ToolCard }
  | { type: "plan"; entries: PlanEntry[] }
  | { type: "commands"; commands: { name: string; description: string }[] }
  | { type: "mode"; modeId: string }
  | { type: "config"; options: unknown[] }
  | { type: "usage"; used: number; size: number };

export const MAX_TEXT = 8000;
const MAX_TITLE = 200;
const MAX_ENTRIES = 50;

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** The last `n` characters (a long command output is most useful at its end). */
const tail = (s: string, n = MAX_TEXT) => (s.length > n ? `[earlier output truncated]\n${s.slice(-n)}` : s);
const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Text of one content block; images and other media give nothing (they are never copied into the UI as HTML). */
export function blockText(block: unknown): string {
  if (!isRecord(block)) return "";
  if (block.type === "text") return str(block.text);
  if (block.type === "resource_link") return head(str(block.name) || str(block.uri), MAX_TITLE);
  if (block.type === "resource" && isRecord(block.resource)) return str(block.resource.text);
  return "";
}

const pick = (o: unknown, keys: string[]): string => {
  if (!isRecord(o)) return "";
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return "";
};

const COMMAND_KEYS = ["command", "CommandLine", "command_line", "commandLine", "cmd"];
const PATH_KEYS = ["path", "file_path", "filePath", "AbsolutePath", "TargetFile", "target_file", "file"];

function locationPath(locations: unknown): string {
  if (!Array.isArray(locations)) return "";
  for (const l of locations) if (isRecord(l) && typeof l.path === "string" && l.path) return l.path;
  return "";
}

function contentOutput(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const c of content.slice(0, 40)) {
    if (!isRecord(c)) continue;
    if (c.type === "content") {
      const t = blockText(c.content);
      if (t) out.push(t);
    } else if (c.type === "diff") {
      const path = str(c.path);
      const next = str(c.newText);
      const prev = typeof c.oldText === "string" ? c.oldText : "";
      const lines = (s: string) => (s ? s.split("\n").length : 0);
      out.push(
        `${path}: ${prev ? "edited" : "new file"} (+${lines(next)} -${lines(prev)} lines)` +
          (!prev && next ? `\n${head(next, 2000)}` : ""),
      );
    }
  }
  return out.join("\n");
}

type ToolState = {
  id: string;
  title: string;
  kind: string;
  status: ToolStatus;
  content: unknown;
  locations: unknown;
  rawInput: unknown;
  rawOutput: unknown;
};

const statusOf = (s: ToolStatus): ToolCard["status"] =>
  s === "completed" ? "success" : s === "failed" ? "error" : "running";

function outputOf(state: ToolState): string | undefined {
  let out = contentOutput(state.content);
  if (!out && isRecord(state.rawOutput))
    out = pick(state.rawOutput, ["combinedOutput", "combined_output", "output", "stdout", "text"]);
  if (!out && typeof state.rawOutput === "string") out = state.rawOutput;
  return out ? tail(out) : undefined;
}

/** What a tool call looks like to the chat cards (names the cards know: shell, read, edit, search, web_fetch). */
function card(state: ToolState): ToolCard {
  const raw = state.rawInput;
  const path = locationPath(state.locations) || pick(raw, PATH_KEYS);
  const base = { id: `acp:${state.id}`, status: statusOf(state.status), output: outputOf(state) };
  switch (state.kind) {
    case "execute":
      return { ...base, name: "shell", args: { command: head(pick(raw, COMMAND_KEYS) || state.title, 2000) } };
    case "read":
      return { ...base, name: "read", args: { path: path || state.title } };
    case "edit":
      return { ...base, name: "edit", args: { path: path || state.title } };
    case "search":
      return {
        ...base,
        name: "search",
        args: { query: head(pick(raw, ["query", "pattern", "Query"]) || state.title, 300) },
      };
    case "fetch":
      return { ...base, name: "web_fetch", args: { url: head(pick(raw, ["url", "Url", "URL"]) || state.title, 500) } };
    default:
      return { ...base, name: state.title || state.kind || "tool", args: path ? { path } : {} };
  }
}

const STATUSES = new Set<string>(["pending", "in_progress", "completed", "failed"]);
const toolStatus = (v: unknown, fallback: ToolStatus): ToolStatus =>
  STATUSES.has(v as string) ? (v as ToolStatus) : fallback;

/** Bounded raw payload kept for argument extraction only (never shown as is). */
function keepRaw(v: unknown): unknown {
  if (typeof v === "string") return head(v, MAX_TEXT);
  if (!isRecord(v)) return undefined;
  const out: Json = {};
  for (const [k, val] of Object.entries(v).slice(0, 40)) if (typeof val === "string") out[k] = head(val, MAX_TEXT);
  return out;
}

/**
 * Stateful mapper for one session: `tool_call_update` patches the call announced by `tool_call` (fields that are
 * absent keep their value, as the spec says). `map` never throws.
 */
export function createUpdateMapper() {
  const tools = new Map<string, ToolState>();
  // v2 sends both streamed chunks and a final whole message; the whole message is shown only when no chunk of it was.
  const streamed = new Set<string>();
  return {
    map(update: unknown): UpdateEvent[] {
      if (!isRecord(update)) return [];
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = blockText(update.content);
          if (typeof update.messageId === "string") streamed.add(update.messageId);
          return text ? [{ type: "text", text }] : [];
        }
        case "agent_message": {
          const id = str(update.messageId);
          if (id && streamed.has(id)) return [];
          if (id) streamed.add(id);
          const text = Array.isArray(update.content) ? update.content.slice(0, 20).map(blockText).join("") : "";
          return text ? [{ type: "text", text }] : [];
        }
        case "tool_call_content_chunk": {
          const old = tools.get(str(update.toolCallId));
          if (!old) return [];
          // A v2 chunk carries one ToolCallContent (`content` or `diff`) to append.
          const known =
            isRecord(update.content) && (update.content.type === "content" || update.content.type === "diff");
          const before = Array.isArray(old.content) ? old.content.slice(-39) : [];
          const next = { ...old, content: known ? [...before, update.content] : before };
          tools.set(old.id, next);
          return [{ type: "tool", card: card(next) }];
        }
        case "agent_thought_chunk": {
          const text = blockText(update.content);
          return text ? [{ type: "thought", text }] : [];
        }
        case "tool_call":
        case "tool_call_update": {
          const id = str(update.toolCallId);
          if (!id || id.length > 200) return [];
          const old = tools.get(id);
          if (!old && tools.size >= 500) return []; // an agent that never stops inventing calls
          const next: ToolState = {
            id,
            title:
              update.title !== undefined
                ? head(str(update.title), MAX_TITLE)
                : (old?.title ?? head(str(update.name), MAX_TITLE)),
            kind: update.kind !== undefined ? str(update.kind) : (old?.kind ?? ""),
            status: toolStatus(
              update.status,
              old?.status ?? (update.sessionUpdate === "tool_call" ? "pending" : "in_progress"),
            ),
            content: update.content !== undefined ? update.content : old?.content,
            locations: update.locations !== undefined ? update.locations : old?.locations,
            rawInput: update.rawInput !== undefined ? keepRaw(update.rawInput) : old?.rawInput,
            rawOutput: update.rawOutput !== undefined ? keepRaw(update.rawOutput) : old?.rawOutput,
          };
          tools.set(id, next);
          return [{ type: "tool", card: card(next) }];
        }
        case "plan":
        case "plan_update": {
          // v2: `plan_update` carries `plan: { type: "items", entries }` (file and markdown plans have no entries).
          const list =
            update.sessionUpdate === "plan_update" && isRecord(update.plan) ? update.plan.entries : update.entries;
          if (!Array.isArray(list)) return [];
          const entries = list.slice(0, MAX_ENTRIES).flatMap((e): PlanEntry[] => {
            if (!isRecord(e) || typeof e.content !== "string") return [];
            const st = e.status === "in_progress" || e.status === "completed" ? e.status : "pending";
            return [{ content: head(e.content, 300), status: st, priority: str(e.priority) || undefined }];
          });
          return [{ type: "plan", entries }];
        }
        case "available_commands_update": {
          if (!Array.isArray(update.availableCommands)) return [];
          const commands = update.availableCommands
            .slice(0, 200)
            .flatMap((c) =>
              isRecord(c) && typeof c.name === "string" && c.name
                ? [{ name: head(c.name, 80), description: head(str(c.description), 200) }]
                : [],
            );
          return [{ type: "commands", commands }];
        }
        case "current_mode_update": {
          const modeId = str(update.currentModeId);
          return modeId ? [{ type: "mode", modeId }] : [];
        }
        case "config_option_update":
          return Array.isArray(update.configOptions) ? [{ type: "config", options: update.configOptions }] : [];
        case "usage_update": {
          const used = Number(update.used);
          const size = Number(update.size);
          return Number.isFinite(used) && Number.isFinite(size) ? [{ type: "usage", used, size }] : [];
        }
        default:
          return []; // user_message_chunk (history replay), session_info_update and kinds this version does not know
      }
    },
    /** Calls that never reported a final status (the turn ended or was cut off). */
    openCalls(): ToolCard[] {
      return [...tools.values()].filter((t) => t.status === "pending" || t.status === "in_progress").map(card);
    },
  };
}

/** The checklist text of a plan card. */
export function planText(entries: PlanEntry[]): string {
  return entries
    .map((e) => `${e.status === "completed" ? "[x]" : e.status === "in_progress" ? "[~]" : "[ ]"} ${e.content}`)
    .join("\n");
}
