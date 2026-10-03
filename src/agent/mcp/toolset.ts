// Turning MCP tools into agent tools and back: tool-list validation, JSON Schema sanitizing, `mcp__<server>__<tool>`
// names with collision handling, the approval policy, and mapping `tools/call` results into tool_result parts.
// Pure: unit-tested in tests/mcp.test.mjs.
import type { ToolDef } from "../../providers/types";
import type { McpServer } from "./config";
import { RESOURCE_TOOLS, resourceToolDefs } from "./resources";

export const MCP_PREFIX = "mcp__";
export const MAX_NAME = 64;
export const MAX_TOOLS_PER_SERVER = 64;
export const MAX_TOOLS_TOTAL = 128;
export const MAX_SCHEMA_BYTES = 16_000;
export const MAX_DESCRIPTION = 1024;
export const MAX_RESULT_TEXT = 50_000;
export const MAX_IMAGE_BASE64 = 5_000_000;

export type McpTool = { name: string; title?: string; description: string; inputSchema: unknown; readOnlyHint?: boolean; destructiveHint?: boolean };
/** `tool` is the server's tool name, or for the built-in resource tools their policy key (`mcp_list_resources` / `mcp_read_resource`). */
export type McpRoute = { serverId: string; server: string; tool: string; kind?: "tool" | "list_resources" | "read_resource" };

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Validates a `tools/list` page: named, unique tools with bounded text. */
export function normalizeTools(raw: unknown): McpTool[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as any).tools) ? ((raw as any).tools as unknown[]) : [];
  const seen = new Set<string>();
  const out: McpTool[] = [];
  for (const t of list.slice(0, 1000)) {
    if (!t || typeof t !== "object") continue;
    const r = t as Record<string, any>;
    if (typeof r.name !== "string" || !r.name || r.name.length > 128 || seen.has(r.name)) continue;
    seen.add(r.name);
    const a = r.annotations && typeof r.annotations === "object" ? r.annotations : {};
    const title = typeof r.title === "string" ? r.title : typeof a.title === "string" ? a.title : undefined;
    out.push({
      name: r.name,
      ...(title ? { title: clip(title, 120) } : {}),
      description: typeof r.description === "string" ? clip(r.description, 4000) : "",
      inputSchema: r.inputSchema,
      ...(a.readOnlyHint === true ? { readOnlyHint: true } : {}),
      ...(a.destructiveHint === true ? { destructiveHint: true } : {}),
    });
  }
  return out;
}

// Keys whose value is a map of name → schema: names there are user data and must not be filtered like keywords.
const MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const DROPPED = new Set(["$schema", "$id", "$comment", "$anchor", "$dynamicAnchor", "examples"]);
const VERBOSE = new Set(["description", "title", "examples", "default", "$comment"]);
const COMBINATORS_TOP = ["anyOf", "oneOf", "allOf", "not", "enum", "const", "if", "then", "else"];
const PERMISSIVE = { type: "object", properties: {}, additionalProperties: true };

function clean(v: unknown, depth: number, drop: Set<string>, isMap = false): unknown {
  if (depth > 16) return {};
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => clean(x, depth + 1, drop));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v).slice(0, 300)) {
      if (!isMap && drop.has(k)) continue;
      const c = clean(val, depth + 1, drop, !isMap && MAP_KEYS.has(k));
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) : v;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean" || v === null) return v;
  return undefined;
}

const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * Makes a tool's inputSchema safe to send to any provider: a plain object schema with `type: "object"` and a
 * `properties` map, no top-level combinators (OpenAI refuses them), no meta keywords, bounded depth and size.
 * Too large: descriptions are dropped first, then the schema becomes a permissive object (`note: "truncated"`).
 */
export function sanitizeSchema(raw: unknown, maxBytes = MAX_SCHEMA_BYTES): { schema: Record<string, unknown>; note?: "invalid" | "truncated" } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { schema: { ...PERMISSIVE }, note: "invalid" };
  const r = raw as Record<string, unknown>;
  if (r.type !== undefined && r.type !== "object") return { schema: { ...PERMISSIVE }, note: "invalid" };
  const build = (drop: Set<string>) => {
    const s = clean(raw, 0, drop) as Record<string, unknown>;
    for (const k of COMBINATORS_TOP) delete s[k];
    s.type = "object";
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) s.properties = {};
    if (s.required !== undefined) {
      const req = Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === "string") : [];
      if (req.length) s.required = req;
      else delete s.required;
    }
    return s;
  };
  let schema = build(DROPPED);
  if (size(schema) <= maxBytes) return { schema };
  schema = build(new Set([...DROPPED, ...VERBOSE]));
  if (size(schema) <= maxBytes) return { schema, note: "truncated" };
  return { schema: { ...PERMISSIVE }, note: "truncated" };
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(4, "0").slice(-4);
};
const part = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** `mcp__<server>__<tool>` within 64 characters of [A-Za-z0-9_-]; a long tool name is cut and given a hash suffix. */
export function mcpToolName(server: string, tool: string): string {
  const head = `${MCP_PREFIX}${part(server).slice(0, 32)}__`;
  const t = part(tool);
  if (head.length + t.length <= MAX_NAME) return head + t;
  return head + t.slice(0, MAX_NAME - head.length - 5) + "_" + hash(tool);
}

/** `name` or `name_2`, `name_3`… (still within 64 characters) when another tool already has it. */
function uniqueToolName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, MAX_NAME - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

export const isMcpToolName = (name: string) => name.startsWith(MCP_PREFIX);

/**
 * Builds the agent's tool definitions for the servers' tools, in order. `reserved` are names already in use (built-in
 * tools). Names that collide after sanitizing or cutting get a numeric suffix; the route map gives the real target.
 */
export function namespaceTools(
  groups: { server: Pick<McpServer, "id" | "name">; tools: McpTool[]; resources?: { list: boolean; read: boolean } }[],
  reserved: Iterable<string> = [],
): { defs: ToolDef[]; route: Map<string, McpRoute>; dropped: number } {
  const taken = new Set(reserved);
  const defs: ToolDef[] = [];
  const route = new Map<string, McpRoute>();
  let dropped = 0;
  for (const g of groups) {
    const tools = g.tools.slice(0, MAX_TOOLS_PER_SERVER);
    dropped += g.tools.length - tools.length;
    for (const t of tools) {
      if (defs.length >= MAX_TOOLS_TOTAL) {
        dropped++;
        continue;
      }
      const name = uniqueToolName(mcpToolName(g.server.name, t.name), taken);
      taken.add(name);
      const label = t.title && t.title !== t.name ? `${t.title}: ` : "";
      defs.push({
        name,
        description: clip(`[MCP server "${g.server.name}", tool "${t.name}"] ${label}${t.description}`.trim(), MAX_DESCRIPTION),
        parameters: sanitizeSchema(t.inputSchema).schema,
      });
      route.set(name, { serverId: g.server.id, server: g.server.name, tool: t.name });
    }
    // Built-in resource tools of a server that offers resources: same naming, collision handling and caps.
    if (g.resources && (g.resources.list || g.resources.read)) {
      const names = { list: "", read: "" };
      if (g.resources.list) {
        names.list = uniqueToolName(mcpToolName(g.server.name, RESOURCE_TOOLS.list), taken);
        taken.add(names.list);
      }
      names.read = uniqueToolName(mcpToolName(g.server.name, RESOURCE_TOOLS.read), taken);
      for (const d of resourceToolDefs(g.server.name, names, g.resources)) {
        if (defs.length >= MAX_TOOLS_TOTAL) {
          dropped++;
          continue;
        }
        taken.add(d.name);
        defs.push(d);
        const list = d.name === names.list;
        route.set(d.name, { serverId: g.server.id, server: g.server.name, tool: list ? RESOURCE_TOOLS.list : RESOURCE_TOOLS.read, kind: list ? "list_resources" : "read_resource" });
      }
    }
  }
  return { defs, route, dropped };
}

export type McpPolicy = Pick<McpServer, "alwaysAllow" | "allowedTools" | "readOnlyTools">;
export type McpDecision = { action: "allow" | "ask" | "block"; reason?: "readonly" | "server" | "tool" };

/**
 * Approval policy for one MCP call: read-only mode refuses tools the user did not mark read-only (server hints do
 * not count); otherwise "always allow" for the server or the tool runs it, and everything else asks. Full access
 * does not skip the question: MCP tools can do anything their server can.
 */
export function decideMcp(p: McpPolicy, tool: string, access: "readonly" | "auto" | "full"): McpDecision {
  if (access === "readonly" && !p.readOnlyTools.includes(tool)) return { action: "block", reason: "readonly" };
  if (p.alwaysAllow) return { action: "allow", reason: "server" };
  if (p.allowedTools.includes(tool)) return { action: "allow", reason: "tool" };
  return { action: "ask" };
}

const PNG = /^iVBORw0KGgo/;

/**
 * Maps a `tools/call` result into tool_result fields: text parts joined, the first PNG image attached (providers send
 * tool images as PNG), other images/audio and binary resources replaced by a note, resource links and embedded text
 * resources rendered as text, `structuredContent` used when there is no content. Text is capped.
 */
export function mapCallResult(raw: unknown, maxText = MAX_RESULT_TEXT): { output: string; image?: string; isError: boolean } {
  if (!raw || typeof raw !== "object") return { output: "Invalid MCP result.", isError: true };
  const r = raw as Record<string, any>;
  const content = Array.isArray(r.content) ? r.content.slice(0, 200) : [];
  const pieces: string[] = [];
  let image: string | undefined;
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const type = String(c.type ?? "");
    const mime = typeof c.mimeType === "string" ? c.mimeType.slice(0, 100) : "";
    if (type === "text") pieces.push(typeof c.text === "string" ? c.text : "");
    else if (type === "image") {
      const ok = typeof c.data === "string" && (mime === "image/png" || !mime) && PNG.test(c.data) && c.data.length <= MAX_IMAGE_BASE64;
      if (ok && !image) {
        image = c.data;
        pieces.push("[image attached]");
      } else pieces.push(`[${mime || "image"} omitted${ok ? ": only one image per result" : typeof c.data === "string" && c.data.length > MAX_IMAGE_BASE64 ? ": too large" : ": unsupported format"}]`);
    } else if (type === "audio") pieces.push(`[${mime || "audio"} omitted]`);
    else if (type === "resource_link") {
      const uri = typeof c.uri === "string" ? c.uri.slice(0, 2000) : "";
      const name = typeof c.name === "string" ? c.name.slice(0, 200) : uri;
      const desc = typeof c.description === "string" ? ` - ${c.description.slice(0, 500)}` : "";
      pieces.push(`[resource link] ${name} <${uri}>${mime ? ` (${mime})` : ""}${desc}`);
    } else if (type === "resource" && c.resource && typeof c.resource === "object") {
      const res = c.resource;
      const uri = typeof res.uri === "string" ? res.uri.slice(0, 2000) : "";
      const rm = typeof res.mimeType === "string" ? ` (${res.mimeType.slice(0, 100)})` : "";
      if (typeof res.text === "string") pieces.push(`[resource ${uri}${rm}]\n${res.text}`);
      else pieces.push(`[binary resource ${uri}${rm}, ${typeof res.blob === "string" ? Math.floor((res.blob.length * 3) / 4) : 0} bytes omitted]`);
    } else pieces.push(`[${clip(type || "unknown", 40)} content omitted]`);
  }
  if (!pieces.length && r.structuredContent !== undefined) {
    try {
      pieces.push(JSON.stringify(r.structuredContent));
    } catch {
      /* not serializable: ignore */
    }
  }
  let output = pieces.join("\n");
  if (output.length > maxText) output = output.slice(0, maxText) + `\n[output truncated: ${output.length - maxText} more characters]`;
  return { output: output || "(no output)", ...(image ? { image } : {}), isError: r.isError === true };
}
