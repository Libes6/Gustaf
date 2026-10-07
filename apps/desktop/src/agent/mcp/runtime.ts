// MCP glue between settings, the Keychain, the transports and the agent: stores server configs (secrets in the
// Keychain), keeps one connection per server (stdio via src-tauri/src/mcp.rs, HTTP via McpHttpClient over Tauri's
// fetch), caches tool lists until the server announces a change, and builds the toolset a run is offered.
import { getSetting, mcpStdio, oauthLoopback, secrets, setSetting } from "../../lib/api";
import { readSecret, removeSecret, storeSecret } from "../../lib/keys";
import type { ToolDef } from "../../providers/types";
import {
  MCP_SETTING,
  normalizeConfig,
  oauthSecretId,
  secretId,
  serversFor,
  splitSecrets,
  staleSecretIds,
  type KV,
  type McpConfig,
  type McpServer,
} from "./config";
import { isLegacySseHint, McpHttpClient, type FetchLike, type HttpOptions, type RemoteClient } from "./http";
import { McpSseClient } from "./sse";
import { parseStored } from "./oauth";
import {
  authorizationHeader,
  isSignedIn,
  refreshTokens,
  revokeTokens,
  signIn,
  signOut,
  type OAuthDeps,
  type Phase,
} from "./oauthFlow";
import { buildPromptArguments, normalizePrompts, renderPromptMessages, type McpPrompt } from "./prompts";
import { checkInitialize } from "./protocol";
import {
  formatResourceList,
  formatTemplateList,
  mapReadResult,
  normalizeResources,
  normalizeResourceTemplates,
  readResourceTarget,
  resolveTemplateUri,
  RESOURCE_TOOLS,
  type McpResource,
  type McpResourceTemplate,
} from "./resources";
import { mapCallResult, namespaceTools, normalizeTools, type McpRoute, type McpTool } from "./toolset";

const CLIENT_VERSION = "0.1.0";
const START_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const MAX_PAGES = 10;

// ---- configuration -------------------------------------------------------------------------------------------------

export const loadMcpConfig = async (): Promise<McpConfig> =>
  normalizeConfig(await getSetting<unknown>(MCP_SETTING, null).catch(() => null));

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
  for (const s of toStore) await storeSecret(s.id, s.value);
  let stale: string[] = [];
  await updateMcpConfig((c) => {
    const prev = c.servers.find((s) => s.id === server.id);
    stale = staleSecretIds(prev, server);
    return { servers: prev ? c.servers.map((s) => (s.id === server.id ? server : s)) : [...c.servers, server] };
  });
  await dropSecrets(stale);
  await disconnectMcpServer(server.id);
}

/**
 * Deletes Keychain entries. OAuth tokens that are dropped because the server was edited or removed are also revoked
 * (RFC 7009, best effort, in the background with the copy read before the delete); a failure never blocks anything.
 */
async function dropSecrets(ids: string[]) {
  for (const id of ids) {
    if (/^mcp:.+:oauth$/.test(id)) {
      const d = await oauthDeps();
      const stored = parseStored(await d.store.get(id).catch(() => null));
      await removeSecret(id, true).catch(() => {});
      if (stored?.revocationEndpoint) void revokeTokens(d, stored).catch(() => {});
    } else await removeSecret(id, true).catch(() => {});
  }
}

export async function removeMcpServer(id: string): Promise<void> {
  let prev: McpServer | undefined;
  await updateMcpConfig((c) => {
    prev = c.servers.find((s) => s.id === id);
    return { servers: c.servers.filter((s) => s.id !== id) };
  });
  await dropSecrets(staleSecretIds(prev, null));
  await disconnectMcpServer(id, true);
}

type PolicyPatch = Partial<Pick<McpServer, "enabled" | "alwaysAllow" | "allowedTools" | "readOnlyTools">>;
export async function patchMcpServer(id: string, patch: PolicyPatch): Promise<void> {
  await updateMcpConfig((c) => ({ servers: c.servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  if (patch.enabled === false) await disconnectMcpServer(id);
}

/** "Always allow" one tool (from the approval card or settings). */
export const allowMcpTool = (id: string, tool: string) =>
  updateMcpConfig((c) => ({
    servers: c.servers.map((s) =>
      s.id === id && !s.allowedTools.includes(tool) ? { ...s, allowedTools: [...s.allowedTools, tool] } : s,
    ),
  }));

// ---- connections ---------------------------------------------------------------------------------------------------

type Cache<T> = { epoch: number; list: T[] };
type Conn = {
  key: string;
  http?: RemoteClient;
  transport?: "streamable" | "sse";
  tools?: Cache<McpTool>;
  resources?: Cache<McpResource>;
  templates?: Cache<McpResourceTemplate>;
  prompts?: Cache<McpPrompt>;
  info?: ReturnType<typeof checkInitialize>;
};
const conns = new Map<string, Conn>();
let httpFetch: FetchLike | null = null;
/** Tests replace the HTTP transport's fetch. */
export const setMcpFetch = (f: FetchLike | null) => void (httpFetch = f);
const getFetch = async (): Promise<FetchLike> =>
  httpFetch ?? ((await import("@tauri-apps/plugin-http")).fetch as unknown as FetchLike);

let oauthOverride: Partial<OAuthDeps> | null = null;
/** Tests replace parts of the OAuth plumbing (browser, listener, Keychain, clock). */
export const setMcpOAuthDeps = (d: Partial<OAuthDeps> | null) => void (oauthOverride = d);
const oauthDeps = async (): Promise<OAuthDeps> => ({
  fetch: await getFetch(),
  openUrl: async (url) => (await import("@tauri-apps/plugin-opener")).openUrl(url),
  loopback: oauthLoopback,
  store: secrets,
  ...oauthOverride,
});

/** Capabilities the server announced in `initialize` (undefined until it was connected once). */
export const mcpCapabilities = (id: string) => conns.get(id)?.info?.capabilities;
/** Which HTTP transport a connected server ended up on (after auto-detection). */
export const mcpTransport = (id: string) => conns.get(id)?.transport;
const hasCapability = (conn: Conn, name: "resources" | "prompts") =>
  !!conn.info?.capabilities &&
  typeof conn.info.capabilities[name] === "object" &&
  conn.info.capabilities[name] !== null;

async function resolveKV(serverId: string, kind: "env" | "header", list: KV[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of list) {
    if (!e.secret) out[e.key] = e.value ?? "";
    else {
      // Read only when this server is started (never at app launch), at most once per session (lib/keys.ts).
      const v = await readSecret(secretId(serverId, kind, e.key)).catch(() => null);
      if (v == null)
        throw new Error(`the secret ${e.key} is missing from the Keychain; edit the server and enter it again`);
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
    const status = await withTimeout(
      mcpStdio.start(server.id, { command: server.command, args: server.args, env, ...(cwd ? { cwd } : {}) }),
      START_TIMEOUT_MS + 5_000,
      "Starting the MCP server",
    );
    const conn = conns.get(server.id) ?? { key: "stdio" };
    conn.info = checkInitialize(status.init);
    conns.set(server.id, conn);
    return conn;
  }
  const headers = await resolveKV(server.id, "header", server.headers);
  const mode = server.httpTransport ?? "auto";
  const key = JSON.stringify([server.url, headers, !!server.oauth, mode]);
  const old = conns.get(server.id);
  if (old?.key === key && old.http && old.info) {
    old.info = await old.http.connect(START_TIMEOUT_MS);
    return old;
  }
  await old?.http?.close();
  // OAuth: the token is read (and refreshed) per request, so one connection survives token changes.
  const auth = server.oauth
    ? {
        header: async () => authorizationHeader(await oauthDeps(), oauthSecretId(server.id)),
        refresh: async () => refreshTokens(await oauthDeps(), oauthSecretId(server.id)),
      }
    : undefined;
  const opts: HttpOptions = {
    url: server.url,
    headers,
    fetch: await getFetch(),
    clientVersion: CLIENT_VERSION,
    ...(auth ? { auth } : {}),
  };
  // "auto": streamable HTTP first; a 4xx answer to its initialize POST (not 401/403/408/429) means a legacy HTTP+SSE server.
  const conn: Conn = {
    key,
    http: mode === "sse" ? new McpSseClient(opts) : new McpHttpClient(opts),
    transport: mode === "sse" ? "sse" : "streamable",
  };
  conns.set(server.id, conn);
  try {
    conn.info = await conn.http!.connect(START_TIMEOUT_MS);
  } catch (e) {
    if (mode !== "auto" || !isLegacySseHint(e)) throw e;
    await conn.http!.close().catch(() => {});
    conn.http = new McpSseClient(opts);
    conn.transport = "sse";
    try {
      conn.info = await conn.http.connect(START_TIMEOUT_MS);
    } catch (e2) {
      throw new Error(
        `${(e2 as Error)?.message ?? e2} (streamable HTTP failed first: HTTP ${e.status}; set the transport in the server settings to skip detection)`,
      );
    }
  }
  return conn;
}

async function rpc(
  server: McpServer,
  conn: Conn,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (conn.http) return conn.http.request(method, params, timeoutMs, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // Stdio: an abort returns at once here, and `mcp_cancel` makes Rust drop the pending call and send
  // notifications/cancelled; an answer that still arrives is ignored there.
  const key = `r${++requestSeq}`;
  const onAbort = () => void mcpStdio.cancel(server.id, key).catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await withTimeout(
      mcpStdio.request(server.id, method, params, timeoutMs, key),
      timeoutMs + 5_000,
      `MCP ${method}`,
      signal,
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
let requestSeq = 0;

type ListKind = "tools" | "resources" | "prompts";
/** Bumped when the server announces `notifications/<kind>/list_changed`; -1 when unknown (then nothing is cached). */
async function epoch(server: McpServer, conn: Conn, kind: ListKind): Promise<number> {
  if (conn.http) return conn.http[`${kind}Epoch`];
  const list = await mcpStdio.status().catch(() => []);
  const st = list.find((s) => s.id === server.id);
  return st ? ((st as Record<string, any>)[`${kind}Epoch`] ?? (kind === "tools" ? -1 : 0)) : -1;
}

/** Follows `nextCursor` (bounded) and collects the validated items of a list method. */
async function listAll<T extends { name?: string; uri?: string }>(
  server: McpServer,
  conn: Conn,
  method: string,
  normalize: (page: unknown) => T[],
  signal?: AbortSignal,
): Promise<T[]> {
  const list: T[] = [];
  const key = (x: T) => x.uri ?? x.name ?? "";
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc(server, conn, method, cursor ? { cursor } : undefined, LIST_TIMEOUT_MS, signal);
    const seen = new Set(list.map(key));
    list.push(...normalize(result).filter((t) => !seen.has(key(t))));
    const next = (result as { nextCursor?: unknown } | null)?.nextCursor;
    if (typeof next !== "string" || !next || next === cursor) break;
    cursor = next;
  }
  return list;
}

/** The server's tools, from cache unless it announced a change (notifications/tools/list_changed) or `force`. */
export async function listMcpTools(server: McpServer, force = false, signal?: AbortSignal): Promise<McpTool[]> {
  const conn = await connect(server);
  const ep = await epoch(server, conn, "tools");
  if (!force && conn.tools && conn.tools.epoch === ep && ep >= 0) return conn.tools.list;
  const list = await listAll(server, conn, "tools/list", normalizeTools, signal);
  conn.tools = { epoch: ep, list };
  return list;
}

/** The server's resources (`resources/list`), cached until `notifications/resources/list_changed`. */
export async function listMcpResources(server: McpServer, force = false, signal?: AbortSignal): Promise<McpResource[]> {
  const conn = await connect(server);
  if (!hasCapability(conn, "resources")) throw new Error(`MCP server ${server.name} does not offer resources`);
  const ep = await epoch(server, conn, "resources");
  if (!force && conn.resources && conn.resources.epoch === ep && ep >= 0) return conn.resources.list;
  const list = await listAll(server, conn, "resources/list", normalizeResources, signal);
  conn.resources = { epoch: ep, list };
  return list;
}

/**
 * The server's resource templates (`resources/templates/list`), cached until `notifications/resources/list_changed`.
 * A server that does not implement the method (JSON-RPC -32601) simply has none.
 */
export async function listMcpResourceTemplates(
  server: McpServer,
  force = false,
  signal?: AbortSignal,
): Promise<McpResourceTemplate[]> {
  const conn = await connect(server);
  if (!hasCapability(conn, "resources")) throw new Error(`MCP server ${server.name} does not offer resources`);
  const ep = await epoch(server, conn, "resources");
  if (!force && conn.templates && conn.templates.epoch === ep && ep >= 0) return conn.templates.list;
  let list: McpResourceTemplate[];
  try {
    list = await listTemplatePages(server, conn, signal);
  } catch (e) {
    if (!/-32601|method not found/i.test(String((e as Error)?.message ?? e))) throw e;
    list = [];
  }
  conn.templates = { epoch: ep, list };
  return list;
}

async function listTemplatePages(server: McpServer, conn: Conn, signal?: AbortSignal): Promise<McpResourceTemplate[]> {
  const list: McpResourceTemplate[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await rpc(
      server,
      conn,
      "resources/templates/list",
      cursor ? { cursor } : undefined,
      LIST_TIMEOUT_MS,
      signal,
    );
    const seen = new Set(list.map((t) => t.uriTemplate));
    list.push(...normalizeResourceTemplates(result).filter((t) => !seen.has(t.uriTemplate)));
    const next = (result as { nextCursor?: unknown } | null)?.nextCursor;
    if (typeof next !== "string" || !next || next === cursor) break;
    cursor = next;
  }
  return list;
}

/** `resources/read` for one URI, mapped to text (capped) with at most one PNG attached. */
export async function readMcpResource(server: McpServer, uri: string, signal?: AbortSignal) {
  const conn = await connect(server);
  if (!hasCapability(conn, "resources")) throw new Error(`MCP server ${server.name} does not offer resources`);
  return mapReadResult(
    await rpc(server, conn, "resources/read", { uri }, server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, signal),
  );
}

/**
 * Reads what `mcp_read_resource` asked for: a URI as is, or a template the server listed (the list is refreshed once
 * when the template is not in the cached one) expanded with validated arguments.
 */
export async function readMcpResourceTarget(server: McpServer, args: unknown, signal?: AbortSignal) {
  const target = readResourceTarget(args);
  if ("uri" in target) return readMcpResource(server, target.uri, signal);
  let templates = await listMcpResourceTemplates(server, false, signal);
  if (!templates.some((t) => t.uriTemplate === target.template))
    templates = await listMcpResourceTemplates(server, true, signal);
  return readMcpResource(server, resolveTemplateUri(templates, target.template, target.arguments), signal);
}

/** Runs the agent's built-in `mcp_list_resources` / `mcp_list_resource_templates` / `mcp_read_resource` tool. */
export async function callMcpResourceTool(
  server: McpServer,
  kind: "list_resources" | "read_resource" | "list_resource_templates",
  args: unknown,
  signal?: AbortSignal,
) {
  if (kind === "list_resources")
    return {
      output: formatResourceList(await listMcpResources(server, false, signal)),
      isError: false as boolean,
      image: undefined as string | undefined,
    };
  if (kind === "list_resource_templates")
    return {
      output: formatTemplateList(await listMcpResourceTemplates(server, false, signal)),
      isError: false as boolean,
      image: undefined as string | undefined,
    };
  return { image: undefined as string | undefined, ...(await readMcpResourceTarget(server, args, signal)) };
}

/** The server's prompts (`prompts/list`), cached until `notifications/prompts/list_changed`. */
export async function listMcpPrompts(server: McpServer, force = false, signal?: AbortSignal): Promise<McpPrompt[]> {
  const conn = await connect(server);
  if (!hasCapability(conn, "prompts")) return [];
  const ep = await epoch(server, conn, "prompts");
  if (!force && conn.prompts && conn.prompts.epoch === ep && ep >= 0) return conn.prompts.list;
  const list = await listAll(server, conn, "prompts/list", normalizePrompts, signal);
  conn.prompts = { epoch: ep, list };
  return list;
}

/**
 * `prompts/get`, rendered as text for the composer. Only ever called for a prompt the user chose and filled in; the
 * result is inserted into the composer and never sent anywhere by itself.
 */
export async function getMcpPrompt(
  server: McpServer,
  prompt: McpPrompt,
  values: Record<string, string>,
  signal?: AbortSignal,
) {
  const conn = await connect(server);
  const result = await rpc(
    server,
    conn,
    "prompts/get",
    { name: prompt.name, arguments: buildPromptArguments(prompt, values) },
    server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    signal,
  );
  return renderPromptMessages(result);
}

/** Prompts of every enabled server that applies to `project` (the composer's picker). A server that fails is reported, not fatal. */
export async function listPromptsForPicker(
  project: string | null,
  signal?: AbortSignal,
): Promise<{ server: McpServer; prompts: McpPrompt[]; error?: string }[]> {
  const servers = serversFor(await loadMcpConfig(), project);
  return Promise.all(
    servers.map(async (server) => {
      try {
        return {
          server,
          prompts: await withTimeout(
            listMcpPrompts(server, false, signal),
            START_TIMEOUT_MS + LIST_TIMEOUT_MS,
            `MCP server ${server.name}`,
            signal,
          ),
        };
      } catch (e) {
        return { server, prompts: [], error: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    }),
  );
}

export async function callMcpTool(server: McpServer, tool: string, args: unknown, signal?: AbortSignal) {
  const conn = await connect(server);
  const result = await rpc(
    server,
    conn,
    "tools/call",
    { name: tool, arguments: args && typeof args === "object" ? args : {} },
    server.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    signal,
  );
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

// ---- OAuth sign-in (HTTP servers with `oauth` set) -------------------------------------------------------------------

/** Whether tokens for this server are in the Keychain (not whether they are still valid: a 401 refreshes or asks to sign in). */
export const isMcpSignedIn = async (server: McpServer) =>
  server.transport === "http" && !!server.oauth && isSignedIn(await oauthDeps(), oauthSecretId(server.id));

/**
 * Browser sign-in (discovery, PKCE, loopback redirect, token exchange); tokens go to the Keychain. Aborting `signal`
 * closes the local listener. The connection is dropped so the next call uses the new tokens.
 */
export async function signInMcpServer(
  server: McpServer,
  o: { signal?: AbortSignal; onPhase?: (p: Phase) => void } = {},
): Promise<void> {
  if (server.transport !== "http" || !server.oauth) throw new Error("OAuth is not enabled for this server");
  const headers = await resolveKV(
    server.id,
    "header",
    server.headers.filter((h) => h.key.toLowerCase() !== "authorization"),
  );
  await signIn(await oauthDeps(), {
    serverUrl: server.url,
    secretId: oauthSecretId(server.id),
    headers,
    ...(server.oauth.clientId ? { clientId: server.oauth.clientId } : {}),
    ...(server.oauth.scope ? { scope: server.oauth.scope } : {}),
    ...o,
  });
  await disconnectMcpServer(server.id);
}

/**
 * Asks the authorization server to revoke the tokens when its metadata had a `revocation_endpoint` (RFC 7009, best
 * effort, a few seconds at most), then deletes the stored tokens whatever happened and ends the session.
 */
export async function signOutMcpServer(server: McpServer): Promise<{ attempted: number; revoked: number }> {
  let result = { attempted: 0, revoked: 0 };
  try {
    result = await signOut(await oauthDeps(), oauthSecretId(server.id));
  } catch {
    await secrets.delete(oauthSecretId(server.id)).catch(() => {});
  }
  await disconnectMcpServer(server.id);
  return result;
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
export async function loadMcpToolset(o: {
  project: string | null;
  access: "readonly" | "auto" | "full";
  reserved?: Iterable<string>;
  signal?: AbortSignal;
}): Promise<McpToolset | null> {
  const list = serversFor(await loadMcpConfig(), o.project);
  if (!list.length) return null;
  const errors: McpToolset["errors"] = [];
  const groups = await Promise.all(
    list.map(async (server) => {
      try {
        const tools = await withTimeout(
          listMcpTools(server, false, o.signal),
          START_TIMEOUT_MS + LIST_TIMEOUT_MS,
          `MCP server ${server.name}`,
          o.signal,
        );
        // Servers that offer resources also get the two built-in resource tools (read-only mode: only those the user marked read-only).
        const caps = conns.get(server.id)?.info?.capabilities;
        const allow = (name: string) => o.access !== "readonly" || server.readOnlyTools.includes(name);
        const resources =
          caps && typeof caps.resources === "object" && caps.resources !== null
            ? {
                list: allow(RESOURCE_TOOLS.list),
                read: allow(RESOURCE_TOOLS.read),
                templates: allow(RESOURCE_TOOLS.templates),
              }
            : undefined;
        return {
          server,
          tools: o.access === "readonly" ? tools.filter((t) => server.readOnlyTools.includes(t.name)) : tools,
          ...(resources ? { resources } : {}),
        };
      } catch (e) {
        errors.push({ server: server.name, message: String((e as Error)?.message ?? e).slice(0, 500) });
        return { server, tools: [] as McpTool[] };
      }
    }),
  );
  const { defs, route } = namespaceTools(groups, o.reserved);
  return { defs, route, servers: new Map(list.map((s) => [s.id, s])), errors };
}
