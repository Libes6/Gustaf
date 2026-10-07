// Codex CLI rollout files: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, one `{timestamp, type, payload}` object per line.
// Lines used: `session_meta` (id, cwd, start time; sessions of a sub-agent thread are skipped), `turn_context` (model) and
// `response_item` with payload types `message` (user / assistant), `function_call`, `custom_tool_call`, `local_shell_call`
// and their outputs. `event_msg` repeats the same content in a UI-oriented shape, so it is ignored, as are `reasoning`,
// `developer` messages and the injected context blocks (`<environment_context>`, AGENTS.md instructions, ...).
// The older layout (first line `{id, timestamp, instructions}` and bare `{type: "message", ...}` items) is accepted too.
import type { Part } from "../../providers/types.ts";
import { IMAGE_OMITTED } from "../exportChats.ts";
import {
  LIMITS,
  capMessages,
  cleanArgs,
  cleanText,
  eachLine,
  outputText,
  pairTools,
  parseLine,
  projectOf,
  rec,
  str,
  titleFrom,
  toMs,
  type ImportedChat,
  type ImportedMessage,
} from "./common.ts";

const INJECTED = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions",
  "<collaboration_mode>",
  "<dynamic_tools>",
  "<recommended_plugins>",
  "<turn_aborted>",
  "<INSTRUCTIONS>",
  "# AGENTS.md instructions",
];

/** User messages Codex adds on its own (context, instructions); never something the person typed. */
export const isInjected = (text: string) => {
  const t = text.trimStart();
  return INJECTED.some((p) => t.startsWith(p));
};

function contentText(content: unknown): string {
  if (str(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (rec(b) ? (str(b.text) ? b.text : /image/.test(String(b.type)) ? IMAGE_OMITTED : "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Arguments arrive as a JSON string; anything else is kept as plain text under `arguments`. */
function parseArgs(raw: unknown): unknown {
  if (rec(raw)) return raw;
  if (!str(raw)) return {};
  try {
    const v = JSON.parse(raw);
    return rec(v) ? v : { arguments: raw };
  } catch {
    return { arguments: raw };
  }
}

/** Older builds wrap the output as `{"output": "...", "metadata": {...}}`. */
function toolOutput(raw: unknown): string {
  if (str(raw) && raw.startsWith("{")) {
    try {
      const v = JSON.parse(raw);
      if (rec(v) && str(v.output)) return v.output;
    } catch {
      /* plain text that happens to start with a brace */
    }
  }
  return outputText(raw);
}

export function parseCodexSession(text: string, fallbackId = ""): ImportedChat | null {
  let skippedLines = 0;
  let id = "";
  let cwd: unknown;
  let model: string | undefined;
  let firstUser = "";
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  let subagent = false;
  let lineNo = 0;
  const messages: ImportedMessage[] = [];
  const names = new Map<string, string>();
  const open = { assistant: null as ImportedMessage | null, tool: null as ImportedMessage | null };

  const addAssistant = (parts: Part[], at?: number) => {
    open.tool = null;
    if (open.assistant) open.assistant.parts.push(...parts);
    else {
      open.assistant = {
        role: "assistant",
        parts,
        createdAt: at,
        meta: { imported: "codex", ...(model ? { model } : {}) },
      };
      messages.push(open.assistant);
    }
  };
  const addResult = (part: Part, at?: number) => {
    open.assistant = null;
    if (open.tool) open.tool.parts.push(part);
    else {
      open.tool = { role: "tool", parts: [part], createdAt: at };
      messages.push(open.tool);
    }
  };
  const addCall = (callId: unknown, name: string, args: unknown, at?: number) => {
    const cid = str(callId) && callId ? callId : `call_${messages.length}_${names.size}`;
    names.set(cid, name);
    addAssistant([{ type: "tool_call", id: cid, name, args: cleanArgs(args) }], at);
  };

  const onLine = (line: string) => {
    lineNo++;
    const o = parseLine(line);
    if (!o) {
      skippedLines++;
      return;
    }
    const at = toMs(o.timestamp);
    if (at) {
      createdAt = Math.min(createdAt ?? at, at);
      updatedAt = Math.max(updatedAt ?? at, at);
    }
    // Header: `session_meta` line, or (older files) an untyped first line carrying the id.
    const header =
      o.type === "session_meta" && rec(o.payload) ? o.payload : lineNo === 1 && !str(o.type) && str(o.id) ? o : null;
    if (header) {
      if (rec(header.source) || str(header.parent_thread_id)) subagent = true;
      if (!id && str(header.id)) id = header.id;
      if (cwd === undefined && str(header.cwd) && header.cwd) cwd = header.cwd;
      const started = toMs(header.timestamp);
      if (started) createdAt = Math.min(createdAt ?? started, started);
      return;
    }
    if (o.type === "turn_context" && rec(o.payload)) {
      if (str(o.payload.model) && o.payload.model) model = o.payload.model.slice(0, 200);
      return;
    }
    // Current files wrap items in `response_item`; older ones store the item itself.
    const item =
      o.type === "response_item" && rec(o.payload)
        ? o.payload
        : o.type === "message" || o.type === "function_call"
          ? o
          : null;
    if (!item) return;
    switch (item.type) {
      case "message": {
        if (item.role !== "user" && item.role !== "assistant") return; // developer / system prompts
        const t = contentText(item.content);
        if (!t.trim()) return;
        if (item.role === "assistant") return addAssistant([{ type: "text", text: cleanText(t) }], at);
        if (isInjected(t)) return;
        open.assistant = null;
        open.tool = null;
        if (!firstUser) firstUser = t;
        messages.push({
          role: "user",
          parts: [{ type: "text", text: cleanText(t) }],
          createdAt: at,
          meta: { imported: "codex" },
        });
        return;
      }
      case "function_call":
        return addCall(
          item.call_id,
          str(item.name) && item.name ? item.name : "function",
          parseArgs(item.arguments),
          at,
        );
      case "custom_tool_call":
        return addCall(item.call_id, str(item.name) && item.name ? item.name : "tool", { input: item.input }, at);
      case "local_shell_call":
        return addCall(item.call_id ?? item.id, "shell", rec(item.action) ? item.action : {}, at);
      case "function_call_output":
      case "custom_tool_call_output":
      case "local_shell_call_output":
        if (str(item.call_id) && item.call_id) {
          addResult(
            {
              type: "tool_result",
              id: item.call_id,
              name: names.get(item.call_id) ?? "",
              output: cleanText(toolOutput(item.output), LIMITS.output),
            },
            at,
          );
        }
        return;
      default:
        return; // reasoning, web_search_call, compaction, ...
    }
  };
  eachLine(text, onLine, () => skippedLines++);

  if (subagent) return null;
  const { messages: kept, clipped } = capMessages(pairTools(messages));
  if (!kept.some((m) => m.role === "user" || m.role === "assistant")) return null;
  const sourceId = id || fallbackId;
  if (!sourceId) return null;
  return {
    source: "codex",
    sourceId,
    title: titleFrom(firstUser) || "Untitled",
    createdAt,
    updatedAt,
    project: projectOf(cwd),
    messages: kept,
    skippedLines,
    clipped,
  };
}
