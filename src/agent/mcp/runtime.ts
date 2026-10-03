// MCP glue between settings, the Keychain, the transports and the agent: stores server configs (secrets in the
// Keychain), keeps one connection per server (stdio via src-tauri/src/mcp.rs, HTTP via McpHttpClient over Tauri's
// fetch), caches tool lists until the server announces a change, and builds the toolset a run is offered.
import { getSetting, mcpStdio, secrets, setSetting } from "../../lib/api";
import type { ToolDef } from "../../providers/types";
import { MCP_SETTING, normalizeConfig, secretId, serversFor, splitSecrets, staleSecretIds, type KV, type McpConfig, type McpServer } from "./config";
import { McpHttpClient, type FetchLike } from "./http";
import { checkInitialize } from "./protocol";
import { mapCallResult, namespaceTools, normalizeTools, type McpRoute, type McpTool } from "./toolset";

const CLIENT_VERSION = "0.1.0";
const START_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_PAGES = 10;

// ---- configuration -------------------------------------------------------------------------------------------------

export const loadMcpConfig = async (): Promise<McpConfig> => normalizeConfig(await getSetting<unknown>(MCP_SETTING, null).catch(() => null));

let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
/** Called after every config change (the settings page and approval card stay in sync). */
export const onMcpConfigChange = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** Read-modify-write of the stored config, one at a time. */
export function updateMcpConfig(fn: (c: McpConfig) => McpConfig): Promise<McpConfig> {
  const run = writes.then(async () => {
    const next = fn(await loadMcpConfig());
    await setSetting(MCP_SETTING, next);
    listeners.forEach((l) => l());
    return next;
  });
  writes = run.catch(() => {});
  return run;
}

/** Saves a server (new or edited): secret values go to the Keychain, unused Keychain entries are removed. */
export async function saveMcpServer(draft: McpServer): Promise<void> {
  const { server, secrets: toStore } = splitSecrets(draft);
  for (const s of toStore) await secrets.set(s.id, s.value);
  let stale: string[] = [];
  await updateMcpConfig((c) => {
    const prev = c.servers.find((s) => s.id === server.id);
    stale = staleSecretIds(prev, server);
    return { servers: prev ? c.servers.map((s) => (s.id === server.id ? server : s)) : [...c.servers, server] };
  });
  for (const id of stale) await secrets.delete(id).catch(() => {});
  await disconnectMcpServer(server.id);
}

export async function removeMcpServer(id: string): Promise<void> {
  let prev: McpServer | undefined;
  await updateMcpConfig((c) => {
    prev = c.servers.find((s) => s.id === id);
    return { servers: c.servers.filter((s) => s.id !== id) };
  });
  for (const sid of staleSecretIds(prev, null)) await secrets.delete(sid).catch(() => {});
  await disconnectMcpServer(id, true);
}

type PolicyPatch = Partial<Pick<McpServer, "enabled" | "alwaysAllow" | "allowedTools" | "readOnlyTools">>;
export async function patchMcpServer(id: string, patch: PolicyPatch): Promise<void> {
  await updateMcpConfig((c) => ({ servers: c.servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  if (patch.enabled === false) await disconnectMcpServer(id);
}

/** "Always allow" one tool (from the approval card or settings). */
export const allowMcpTool = (id: string, tool: string) =>
  updateMcpConfig((c) => ({ servers: c.servers.map((s) => (s.id === id && !s.allowedTools.includes(tool) ? { ...s, allowedTools: [...s.allowedTools, tool] } : s)) }));

// ---- connections ---------------------------------------------------------------------------------------------------

type Conn = { key: string; http?: McpHttpClient; tools?: { epoch: number; list: McpTool[] }; info?: ReturnType<typeof checkInitialize> };
const conns = new Map<string, Conn>();
let httpFetch: FetchLike | null = null;
/** Tests replace the HTTP transport's fetch. */
export const setMcpFetch = (f: FetchLike | null) => void (httpFetch = f);
const getFetch = async (): Promise<FetchLike> => httpFetch ?? ((await import("@tauri-apps/plugin-http")).fetch as unknown as FetchLike);

async function resolveKV(serverId: string, kind: "env" | "header", list: KV[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of list) {
    if (!e.secret) out[e.key] = e.value ?? "";
    else {
      const v = await secrets.get(secretId(serverId, kind, e.key)).catch(() => null);
      if (v == null) throw new Error(`the secret ${e.key} is missing from the Keychain; edit the server and enter it again`);
      out[e.key] = v;
    }
  }
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    });
  });

async function connect(server: McpServer): Promise<Conn> {
  if (server.transport === "stdio") {
    const env = await resolveKV(server.id, "env", server.env);
    const cwd = server.cwd ?? (server.scope === "project" ? server.project : undefined);
    const status = await withTimeout(mcpStdio.start(server.id, { command: server.command, args: server.args, env, ...(cwd ? { cwd } : {}) }), START_TIMEOUT_MS + 5_000, "Starting the MCP server");
    const conn = conns.get(server.id) ?? { key: "stdio" };
    conn.info = checkInitialize(status.init);
    conns.set(server.id, conn);
    return conn;
  }
  const headers = await resolveKV(server.id, "header", server.headers);
  const key = JSON.stringify([server.url, headers]);
  const old = conns.get(server.id);
  if (old?.key === key && old.http) {
    old.info = await old.http.connect(START_TIMEOUT_MS);
    return old;
  }
  await old?.http?.close();
  const http = new McpHttpClient({ url: server.url, headers, fetch: await getFetch(), clientVersion: CLIENT_VERSION });
  const conn: Conn = { key, http };
  conns.set(server.id, conn);
  conn.info = await http.connect(START_TIMEOUT_MS);
  return conn;
}

async function rpc(server: McpServer, conn: Conn, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  if (conn.http) return conn.http.request(method, params, timeoutMs, signal);
  // A stdio call cannot be cancelled on the Rust side; abort just stops waiting (the call still ends at its timeout).
  return withTimeout(mcpStdio.request(server.id, method, params, timeoutMs), timeoutMs + 5_000, `MCP ${method}`, signal);
}

async function toolsEpoch(server: McpServer, conn: Conn): Promise<number> {
  if (conn.http) return conn.http.toolsEpoch;
  const list = await mcpStdio.status().catch(() => []);
  return list.find((s) => s.id === server.id)?.toolsEpoch ?? -1;
}

/** The server's tools, from cache unless it announced a change (notifications/tools/list_changed) or `force`. */
export async function listMcpTools(server: McpServer, force = false, signal?: AbortSignal): Promise<McpTool[]> {
  const conn = await connect(server);
  const epoch = await toolsEpoch(server, conn);
  if (!force && conn.tools && conn.tools.epoch === epoch && epoch >= 0) return conn.tools.list;
  const list: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc(server, conn, "tools/list", cursor ? { cursor } : undefined, LIST_TIMEOUT_MS, signal);
    const seen = new Set(list.map((t) => t.name));
    list.push(...normalizeTools(result).filter((t) => !seen.has(t.name)));
    const next = (result as { nextCursor?: unknown } | null)?.nextCursor;
    if (typeof next !== "string" || !next || next === cursor) break;
    cursor = next;
  }
  conn.tools = { epoch, list };
  return list;
}

export async function callMcpTool(server: McpServer, tool: string, args: unknown, signal?: AbortSignal) {
  const conn = await connect(server);
  const result = await rpc(server, conn, "tools/call", { name: tool, arguments: args && typeof args === "object" ? args : {} }, server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, signal);
  return mapCallResult(result);
}

/** Stops a stdio server (and forgets it when removed) or ends an HTTP session; the next use starts it again. */
export async function disconnectMcpServer(id: string, forget = false) {
  const conn = conns.get(id);
  conns.delete(id);
  await conn?.http?.close().catch(() => {});
  await mcpStdio.stop(id, forget).catch(() => {});
}

/** "Test connection" in settings: starts or reconnects, lists the tools fresh. */
export async function testMcpServer(server: McpServer): Promise<{ tools: McpTool[]; info?: Conn["info"] }> {
  const tools = await listMcpTools(server, true);
  return { tools, info: conns.get(server.id)?.info };
}

// ---- the agent's view ----------------------------------------------------------------------------------------------

export type McpToolset = {
  defs: ToolDef[];
  route: Map<string, McpRoute>;
  servers: Map<string, McpServer>;
  errors: { server: string; message: string }[];
};

/**
 * Tools of the enabled servers that apply to `project`, namespaced as `mcp__<server>__<tool>`. In read-only mode only
 * tools the user marked read-only are offered. A server that fails to start or list is skipped (see `errors`).
 */
export async function loadMcpToolset(o: { project: string | null; access: "readonly" | "auto" | "full"; reserved?: Iterable<string>; signal?: AbortSignal }): Promise<McpToolset | null> {
  const list = serversFor(await loadMcpConfig(), o.project);
  if (!list.length) return null;
  const errors: McpToolset["errors"] = [];
  const groups = await Promise.all(
    list.map(async (server) => {
      try {
        const tools = await withTimeout(listMcpTools(server, false, o.signal), START_TIMEOUT_MS + LIST_TIMEOUT_MS, `MCP server ${server.name}`, o.signal);
        return { server, tools: o.access === "readonly" ? tools.filter((t) => server.readOnlyTools.includes(t.name)) : tools };
      } catch (e) {
        errors.push({ server: server.name, message: String((e as Error)?.message ?? e).slice(0, 500) });
        return { server, tools: [] as McpTool[] };
      }
    }),
  );
  const { defs, route } = namespaceTools(groups, o.reserved);
  return { defs, route, servers: new Map(list.map((s) => [s.id, s])), errors };
}
