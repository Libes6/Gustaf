// MCP prompts as user-invoked templates: validation of `prompts/list` pages, argument handling for the small dialog,
// and rendering `prompts/get` messages as plain text for the composer. Nothing here runs a prompt: the user picks one,
// fills the arguments and the rendered text is only inserted into the composer. Pure: tests/mcpExtras.test.mjs.

export type McpPromptArg = { name: string; description: string; required: boolean };
export type McpPrompt = { name: string; title?: string; description: string; arguments: McpPromptArg[] };

export const MAX_PROMPTS = 200;
export const MAX_PROMPT_ARGS = 20;
export const MAX_ARG_VALUE = 10_000;
export const MAX_PROMPT_TEXT = 20_000;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function normalizePrompts(raw: unknown): McpPrompt[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as any).prompts) ? ((raw as any).prompts as unknown[]) : [];
  const seen = new Set<string>();
  const out: McpPrompt[] = [];
  for (const p of list.slice(0, 1000)) {
    if (!p || typeof p !== "object") continue;
    const x = p as Record<string, any>;
    if (typeof x.name !== "string" || !x.name || x.name.length > 128 || seen.has(x.name)) continue;
    seen.add(x.name);
    const args: McpPromptArg[] = [];
    for (const a of Array.isArray(x.arguments) ? x.arguments.slice(0, MAX_PROMPT_ARGS) : []) {
      if (!a || typeof a !== "object" || typeof a.name !== "string" || !a.name || a.name.length > 128 || args.some((y) => y.name === a.name)) continue;
      args.push({ name: a.name, description: typeof a.description === "string" ? clip(a.description, 300) : "", required: a.required === true });
    }
    out.push({
      name: x.name,
      ...(typeof x.title === "string" && x.title ? { title: clip(x.title, 120) } : {}),
      description: typeof x.description === "string" ? clip(x.description, 500) : "",
      arguments: args,
    });
    if (out.length >= MAX_PROMPTS) break;
  }
  return out;
}

/** Names of required arguments that have no (non-blank) value. */
export const missingPromptArgs = (prompt: McpPrompt, values: Record<string, string>) =>
  prompt.arguments.filter((a) => a.required && !(values[a.name] ?? "").trim()).map((a) => a.name);

/** The `arguments` object for `prompts/get`: only declared arguments, non-empty, strings, bounded. */
export function buildPromptArguments(prompt: McpPrompt, values: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of prompt.arguments) {
    const v = values[a.name];
    if (typeof v === "string" && v.trim()) out[a.name] = v.slice(0, MAX_ARG_VALUE);
  }
  return out;
}

/**
 * Renders `prompts/get` messages as text for the composer: text parts as they are, embedded text resources under a
 * header, other content as a short note. A single user message is inserted bare; with several messages or an
 * assistant turn each is prefixed with its role. Capped at `max` characters.
 */
export function renderPromptMessages(raw: unknown, max = MAX_PROMPT_TEXT): { text: string; truncated: boolean } {
  const messages = raw && typeof raw === "object" && Array.isArray((raw as any).messages) ? ((raw as any).messages as unknown[]).slice(0, 50) : [];
  const parts: { role: string; text: string }[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const x = m as Record<string, any>;
    const content = Array.isArray(x.content) ? x.content : [x.content];
    const texts: string[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && typeof c.text === "string") texts.push(c.text);
      else if (c.type === "resource" && c.resource && typeof c.resource === "object") {
        const uri = typeof c.resource.uri === "string" ? clip(c.resource.uri, 500) : "";
        texts.push(typeof c.resource.text === "string" ? `[resource ${uri}]\n${c.resource.text}` : `[binary resource ${uri} omitted]`);
      } else if (c.type === "resource_link" && typeof c.uri === "string") texts.push(`[resource link ${clip(c.uri, 500)}]`);
      else texts.push(`[${clip(String(c.type ?? "content"), 30)} omitted]`);
    }
    const text = texts.join("\n").trim();
    if (text) parts.push({ role: x.role === "assistant" ? "assistant" : "user", text });
  }
  const plain = parts.length === 1 && parts[0].role === "user";
  let text = plain ? parts[0].text : parts.map((p) => `${p.role === "assistant" ? "Assistant" : "User"}: ${p.text}`).join("\n\n");
  const truncated = text.length > max;
  if (truncated) text = text.slice(0, max);
  return { text, truncated };
}
