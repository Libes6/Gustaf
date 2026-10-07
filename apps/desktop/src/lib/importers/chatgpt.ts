// ChatGPT data export: `conversations.json` is an array of conversations. Each has `mapping`, a tree of nodes
// `{id, parent, children, message}` because editing a prompt or regenerating an answer creates a branch, and
// `current_node`, the leaf of the branch the chat currently shows. The linear thread is the path from the root to
// `current_node`; other branches are not imported. Without a usable `current_node` the walk starts at the root and
// follows the last child at every fork (the newest edit or regeneration).
//
// Messages are kept when written by the user or the assistant and not hidden. Assistant `code` messages addressed to a
// tool (python, browser, ...) become `tool_call`, and the following `tool` messages their `tool_result`. System
// prompts, custom instructions, reasoning recaps and thoughts are dropped; images and audio become a placeholder.
import type { Part } from "../../providers/types.ts";
import { IMAGE_OMITTED } from "../exportChats.ts";
import {
  LIMITS,
  capMessages,
  cleanArgs,
  cleanText,
  pairTools,
  rec,
  str,
  titleFrom,
  toMs,
  type ImportedChat,
  type ImportedMessage,
} from "./common.ts";

type Node = { id?: unknown; parent?: unknown; children?: unknown; message?: unknown };

/** Citation and entity markers in the Private Use Area (`citeturn0search1`) mean nothing outside ChatGPT. */
const MARKERS = /[^]*|[-]/g;
const MAX_WALK = 200_000;

/** Node ids from the root to the shown leaf. */
export function threadPath(mapping: Record<string, Node>, currentNode: unknown): string[] {
  // Own keys only: an id like "constructor" must not resolve to something on Object.prototype.
  const has = (k: unknown): k is string =>
    str(k) && Object.prototype.hasOwnProperty.call(mapping, k) && rec(mapping[k]);
  const path: string[] = [];
  const seen = new Set<string>();
  let id: string | undefined = has(currentNode) ? currentNode : undefined;
  if (id) {
    while (id && !seen.has(id) && path.length < MAX_WALK) {
      seen.add(id);
      path.push(id);
      const parent: unknown = mapping[id].parent;
      id = has(parent) ? parent : undefined;
    }
    return path.reverse();
  }
  id = Object.keys(mapping).find((k) => has(k) && !has(mapping[k].parent));
  while (id && !seen.has(id) && path.length < MAX_WALK) {
    seen.add(id);
    path.push(id);
    const kids: unknown = mapping[id].children;
    const next: unknown = Array.isArray(kids) ? [...kids].reverse().find((k) => has(k) && !seen.has(k)) : undefined;
    id = has(next) ? next : undefined;
  }
  return path;
}

type Content = { text: string; code: boolean };

/** Text of a message `content` object; null when it has nothing worth keeping. */
function contentOf(c: unknown): Content | null {
  if (!rec(c)) return null;
  const type = str(c.content_type) ? c.content_type : "";
  if (["thoughts", "reasoning_recap", "user_editable_context", "model_editable_context", "system_error"].includes(type))
    return null;
  if (type === "code") return str(c.text) ? { text: c.text, code: true } : null;
  if (Array.isArray(c.parts)) {
    const pieces = c.parts.map((p: unknown) => {
      if (str(p)) return p;
      if (rec(p) && str(p.content_type)) {
        if (/image/.test(p.content_type)) return IMAGE_OMITTED;
        if (str(p.text)) return p.text;
      }
      return "";
    });
    return { text: pieces.filter((p: string) => p).join("\n"), code: false };
  }
  if (str(c.text)) return { text: c.text, code: false };
  return null;
}

const visible = (m: Record<string, any>) => {
  const meta = rec(m.metadata) ? m.metadata : {};
  return meta.is_visually_hidden_from_conversation !== true && meta.is_user_system_message !== true;
};

export function parseChatGptConversation(input: unknown, fallbackId = ""): ImportedChat | null {
  let conv: unknown = input;
  if (str(input)) {
    try {
      conv = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!rec(conv) || !rec(conv.mapping)) return null;
  const mapping = conv.mapping as Record<string, Node>;
  const id =
    str(conv.id) && conv.id
      ? conv.id
      : str(conv.conversation_id) && conv.conversation_id
        ? conv.conversation_id
        : fallbackId;
  if (!id) return null;

  const messages: ImportedMessage[] = [];
  const pending: { id: string; name: string }[] = [];
  let firstUser = "";
  let callNo = 0;
  for (const nodeId of threadPath(mapping, conv.current_node)) {
    const m = mapping[nodeId].message;
    if (!rec(m) || !rec(m.author) || !visible(m)) continue;
    const content = contentOf(m.content);
    if (!content) continue;
    const text = content.text.replace(MARKERS, "");
    if (!text.trim()) continue;
    const at = toMs(m.create_time, "seconds");
    const role = m.author.role;
    const meta = rec(m.metadata) ? m.metadata : {};
    const model = str(meta.model_slug) && meta.model_slug ? meta.model_slug.slice(0, 200) : undefined;
    if (role === "user") {
      pending.length = 0;
      if (!firstUser) firstUser = text;
      messages.push({
        role: "user",
        parts: [{ type: "text", text: cleanText(text) }],
        createdAt: at,
        meta: { imported: "chatgpt" },
      });
    } else if (role === "assistant") {
      const recipient = str(m.recipient) && m.recipient !== "all" ? m.recipient : "";
      const parts: Part[] = [];
      if (content.code && recipient) {
        const call = { id: `call_${++callNo}`, name: recipient.slice(0, 100) };
        pending.push(call);
        parts.push({ type: "tool_call", id: call.id, name: call.name, args: cleanArgs({ input: text }) });
      } else {
        parts.push({ type: "text", text: cleanText(text) });
      }
      const last = messages[messages.length - 1];
      // Consecutive assistant messages (a call and the text around it) form one turn.
      if (last?.role === "assistant") last.parts.push(...parts);
      else
        messages.push({
          role: "assistant",
          parts,
          createdAt: at,
          meta: { imported: "chatgpt", ...(model ? { model } : {}) },
        });
    } else if (role === "tool") {
      const call = pending.shift();
      if (!call) continue;
      messages.push({
        role: "tool",
        parts: [{ type: "tool_result", id: call.id, name: call.name, output: cleanText(text, LIMITS.output) }],
        createdAt: at,
      });
    }
  }
  const { messages: kept, clipped } = capMessages(pairTools(messages));
  if (!kept.some((m) => m.role === "user" || m.role === "assistant")) return null;
  const created = toMs(conv.create_time, "seconds") ?? kept.find((m) => m.createdAt)?.createdAt;
  const updated =
    toMs(conv.update_time, "seconds") ?? [...kept].reverse().find((m) => m.createdAt)?.createdAt ?? created;
  return {
    source: "chatgpt",
    sourceId: id,
    title: str(conv.title) && conv.title.trim() ? titleFrom(conv.title) : titleFrom(firstUser) || "Untitled",
    createdAt: created,
    updatedAt: updated,
    project: null,
    messages: kept,
    skippedLines: 0,
    clipped,
  };
}
