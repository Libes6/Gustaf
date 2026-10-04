// MCP server configuration: shapes stored in settings (`mcpServers`), validation, and import from the common
// `mcpServers` JSON (Claude Desktop / Cursor / VS Code style). Pure: unit-tested in tests/mcp.test.mjs.
// Secret values of env vars and headers never live in settings: `splitSecrets` moves them to Keychain entries
// (`secretId`), and the stored entry keeps only `{ key, secret: true }`.

export const MCP_SETTING = "mcpServers";
export const LIMITS = { servers: 50, name: 32, command: 4096, args: 256, arg: 16384, entries: 100, value: 16384, url: 2048, path: 4096, tools: 200 };

/** An env var or header. `value` is absent for a secret that is in the Keychain (or unchanged in an edit form). */
export type KV = { key: string; value?: string; secret: boolean };
type Base = {
  id: string;
  name: string;
  enabled: boolean;
  scope: "global" | "project";
  /** Project folder for `scope: "project"`. */
  project?: string;
  /** Run every tool of this server without asking. */
  alwaysAllow: boolean;
  /** Tools that run without asking. */
  allowedTools: string[];
  /** Tools the user marked read-only: the only ones offered in read-only mode. */
  readOnlyTools: string[];
  /** Per-call timeout (ms); default 60 s. */
  timeoutMs?: number;
};
export type StdioServer = Base & { transport: "stdio"; command: string; args: string[]; env: KV[]; cwd?: string };
/** OAuth sign-in for an HTTP server: tokens live in the Keychain (`oauthSecretId`), never here. `clientId` skips dynamic registration. */
export type OAuthConfig = { clientId?: string; scope?: string };
/** How an HTTP server is spoken to: streamable HTTP, the legacy HTTP+SSE transport, or detect (streamable first, SSE when the initialize POST gets a 4xx). Absent means "auto". */
export type HttpTransport = "auto" | "streamable" | "sse";
export const HTTP_TRANSPORTS: readonly HttpTransport[] = ["auto", "streamable", "sse"];
export type HttpServer = Base & { transport: "http"; url: string; headers: KV[]; oauth?: OAuthConfig; httpTransport?: HttpTransport };
export type McpServer = StdioServer | HttpServer;
export type McpConfig = { servers: McpServer[] };

export type ImportError = { name: string; code: ErrorCode };
export type ErrorCode =
  | "json" | "empty" | "invalid" | "name" | "nameTaken" | "command" | "args" | "envKey" | "value" | "url" | "headerName" | "project" | "cwd" | "sse" | "tooMany" | "oauth" | "transport";

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const SECRETISH = /key|token|secret|passw|pwd|auth|credential|cookie|session|private|bearer|signature/i;

export const secretId = (serverId: string, kind: "env" | "header", key: string) => `mcp:${serverId}:${kind}:${key}`;
/** Keychain entry holding a server's OAuth tokens (JSON, see oauth.ts `StoredOAuth`). */
export const oauthSecretId = (serverId: string) => `mcp:${serverId}:oauth`;
/** Whether a value should go to the Keychain by default (the user can change it per entry). */
export const looksSecret = (key: string, value = "") => SECRETISH.test(key) || /^(bearer|basic)\s/i.test(value) || /^(sk|ghp|gho|github_pat|xox[abp]|glpat)[-_]/i.test(value);

/** Turns any label into a server name usable in tool names (`mcp__<name>__<tool>`). */
export function slugName(raw: string): string {
  const s = String(raw ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, LIMITS.name);
  return s || "server";
}

/** `name`, or `name_2`, `name_3`… when taken (case-insensitive). */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((n) => n.toLowerCase()));
  if (!set.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = name.slice(0, LIMITS.name - suffix.length) + suffix;
    if (!set.has(candidate.toLowerCase())) return candidate;
  }
}

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
/** https anywhere; plain http only to this machine (the app's HTTP scope allows nothing else). */
export function validUrl(url: string): boolean {
  if (typeof url !== "string" || url.length > LIMITS.url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && isLocalHost(u.hostname));
  } catch {
    return false;
  }
}

const validOAuth = (o: unknown) => {
  if (!o || typeof o !== "object") return false;
  const { clientId, scope } = o as OAuthConfig;
  const ok = (v: unknown) => v === undefined || (typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f]/.test(v));
  return ok(clientId) && ok(scope);
};
const badValue = (v: unknown) => v !== undefined && (typeof v !== "string" || v.length > LIMITS.value || v.includes("\0"));

/** POSIX, absolute drive paths and UNC shares; never drive-relative or NUL-containing paths. */
const absolutePath = (p: unknown): p is string => typeof p === "string" && p.length <= LIMITS.path && !p.includes("\0") &&
  (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p));

/** Problems with a server, as codes (the UI translates them). `others` are the other configured servers. */
export function validateServer(s: McpServer, others: readonly McpServer[] = []): ErrorCode[] {
  const errors = new Set<ErrorCode>();
  if (!NAME_RE.test(s.name)) errors.add("name");
  else if (others.some((o) => o.id !== s.id && o.name.toLowerCase() === s.name.toLowerCase())) errors.add("nameTaken");
  if (s.scope === "project" && !absolutePath(s.project)) errors.add("project");
  if (s.transport === "stdio") {
    if (typeof s.command !== "string" || !s.command.trim() || s.command.length > LIMITS.command || s.command.includes("\0")) errors.add("command");
    if (!Array.isArray(s.args) || s.args.length > LIMITS.args || s.args.some((a) => typeof a !== "string" || a.length > LIMITS.arg || a.includes("\0"))) errors.add("args");
    if (!Array.isArray(s.env) || s.env.length > LIMITS.entries || s.env.some((e) => !ENV_RE.test(e.key))) errors.add("envKey");
    if (s.env?.some((e) => badValue(e.value))) errors.add("value");
    if (s.cwd !== undefined && !absolutePath(s.cwd)) errors.add("cwd");
  } else {
    if (!validUrl(s.url)) errors.add("url");
    if (!Array.isArray(s.headers) || s.headers.length > LIMITS.entries || s.headers.some((h) => !HEADER_RE.test(h.key))) errors.add("headerName");
    if (s.headers?.some((h) => badValue(h.value) || /[\r\n]/.test(h.value ?? ""))) errors.add("value");
    if (s.oauth !== undefined && !validOAuth(s.oauth)) errors.add("oauth");
    if (s.httpTransport !== undefined && !HTTP_TRANSPORTS.includes(s.httpTransport)) errors.add("transport");
  }
  return [...errors];
}

const strList = (v: unknown, max: number, each = 512) =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= each))].slice(0, max) : [];

function kvList(raw: unknown, keepValues: boolean): KV[] {
  if (!Array.isArray(raw)) return [];
  const out: KV[] = [];
  for (const e of raw.slice(0, LIMITS.entries)) {
    if (!e || typeof e !== "object" || typeof e.key !== "string" || !e.key) continue;
    const secret = e.secret === true;
    // A secret value found in settings (should never happen) is dropped rather than kept in plain text.
    const value = typeof e.value === "string" && (!secret || keepValues) ? e.value : undefined;
    out.push({ key: e.key, secret, ...(value !== undefined ? { value } : {}) });
  }
  return out;
}

const oauthFrom = (o: Record<string, unknown>): OAuthConfig => ({
  ...(typeof o.clientId === "string" && o.clientId.trim() ? { clientId: o.clientId.trim() } : {}),
  ...(typeof o.scope === "string" && o.scope.trim() ? { scope: o.scope.trim() } : {}),
});

/** Accepts whatever was persisted and returns the valid servers; secret values are never read from settings. */
export function normalizeConfig(raw: unknown): McpConfig {
  const list = raw && typeof raw === "object" && Array.isArray((raw as any).servers) ? ((raw as any).servers as unknown[]) : [];
  const servers: McpServer[] = [];
  for (const item of list.slice(0, LIMITS.servers)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, any>;
    if (typeof r.id !== "string" || !r.id || typeof r.name !== "string") continue;
    const base = {
      id: r.id,
      name: r.name,
      enabled: r.enabled !== false,
      scope: r.scope === "project" ? ("project" as const) : ("global" as const),
      ...(typeof r.project === "string" && r.project ? { project: r.project } : {}),
      alwaysAllow: r.alwaysAllow === true,
      allowedTools: strList(r.allowedTools, LIMITS.tools),
      readOnlyTools: strList(r.readOnlyTools, LIMITS.tools),
      ...(typeof r.timeoutMs === "number" && r.timeoutMs >= 1000 && r.timeoutMs <= 600_000 ? { timeoutMs: Math.round(r.timeoutMs) } : {}),
    };
    const s: McpServer =
      r.transport === "http"
        ? { ...base, transport: "http", url: String(r.url ?? ""), headers: kvList(r.headers, false), ...(r.oauth && typeof r.oauth === "object" ? { oauth: oauthFrom(r.oauth) } : {}), ...(r.httpTransport === "streamable" || r.httpTransport === "sse" ? { httpTransport: r.httpTransport as HttpTransport } : {}) }
        : { ...base, transport: "stdio", command: String(r.command ?? ""), args: Array.isArray(r.args) ? [...r.args] : [], env: kvList(r.env, false), ...(typeof r.cwd === "string" && r.cwd ? { cwd: r.cwd } : {}) };
    if (validateServer(s, servers).length) continue;
    servers.push(s);
  }
  return { servers };
}

/** Moves secret values out of a server: what to store in settings, and the Keychain writes to make. */
export function splitSecrets(s: McpServer): { server: McpServer; secrets: { id: string; value: string }[] } {
  const secrets: { id: string; value: string }[] = [];
  const strip = (kind: "env" | "header", list: KV[]) =>
    list.map((e) => {
      if (!e.secret) return { key: e.key, secret: false, value: e.value ?? "" };
      if (e.value !== undefined) secrets.push({ id: secretId(s.id, kind, e.key), value: e.value });
      return { key: e.key, secret: true };
    });
  const server: McpServer = s.transport === "stdio" ? { ...s, env: strip("env", s.env) } : { ...s, headers: strip("header", s.headers) };
  return { server, secrets };
}

/** Keychain ids that a previous version of the server used and the new one no longer does (removed or made non-secret). */
export function staleSecretIds(prev: McpServer | undefined, next: McpServer | null): string[] {
  if (!prev) return [];
  const ids = (s: McpServer) => (s.transport === "stdio" ? s.env.filter((e) => e.secret).map((e) => secretId(s.id, "env", e.key)) : s.headers.filter((h) => h.secret).map((h) => secretId(s.id, "header", h.key)));
  const keep = new Set(next ? ids(next) : []);
  const stale = ids(prev).filter((id) => !keep.has(id));
  // OAuth tokens belong to one server URL and client: dropped when the sign-in is turned off or either changes.
  if (prev.transport === "http" && prev.oauth && !(next && next.transport === "http" && next.oauth && next.url === prev.url && next.oauth.clientId === prev.oauth.clientId)) stale.push(oauthSecretId(prev.id));
  return stale;
}

/** Enabled servers that apply to a run in `project` (global ones plus those bound to that folder). */
export const serversFor = (config: McpConfig, project: string | null) =>
  config.servers.filter((s) => s.enabled && (s.scope === "global" || (!!project && s.project === project)));

function kvFrom(raw: unknown, kind: "env" | "header"): KV[] | null {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  return Object.entries(raw as Record<string, unknown>).map(([key, v]) => {
    const value = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    return { key, value, secret: (kind === "header" && /^(authorization|proxy-authorization|cookie|x-api-key)$/i.test(key)) || looksSecret(key, value) };
  });
}

/**
 * Parses pasted JSON in the common shapes: `{ "mcpServers": { name: {...} } }`, VS Code's `{ "servers": {...} }`, or a
 * bare `{ name: {...} }` map (also without the outer braces). Entries: `command`/`args`/`env`/`cwd` (stdio) or
 * `url`/`headers` (HTTP: `type: "sse"` selects the legacy SSE transport, `"http"` / `"streamable-http"` streamable HTTP, otherwise it is detected). Names are made unique against
 * `existing`. Returned servers still carry their secret values; `splitSecrets` runs when they are saved.
 */
export function parseImport(text: string, existing: readonly McpServer[], newId: () => string): { servers: McpServer[]; errors: ImportError[] } {
  let data: unknown;
  const src = String(text ?? "").trim();
  if (!src) return { servers: [], errors: [{ name: "", code: "empty" }] };
  try {
    data = JSON.parse(src);
  } catch {
    try {
      data = JSON.parse(`{${src.replace(/,\s*$/, "")}}`);
    } catch {
      return { servers: [], errors: [{ name: "", code: "json" }] };
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { servers: [], errors: [{ name: "", code: "invalid" }] };
  const d = data as Record<string, any>;
  const map = d.mcpServers ?? d.servers ?? d.mcp?.servers ?? d;
  if (!map || typeof map !== "object" || Array.isArray(map) || typeof map.command === "string" || typeof map.url === "string")
    return { servers: [], errors: [{ name: "", code: "invalid" }] };
  const servers: McpServer[] = [];
  const errors: ImportError[] = [];
  const entries = Object.entries(map as Record<string, unknown>);
  if (!entries.length) return { servers, errors: [{ name: "", code: "empty" }] };
  for (const [label, value] of entries) {
    if (existing.length + servers.length >= LIMITS.servers) {
      errors.push({ name: label, code: "tooMany" });
      break;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push({ name: label, code: "invalid" });
      continue;
    }
    const v = value as Record<string, any>;
    const type = String(v.type ?? v.transport ?? "").toLowerCase();
    if (type === "sse" && typeof (v.url ?? v.serverUrl) !== "string") {
      errors.push({ name: label, code: "url" });
      continue;
    }
    const name = uniqueName(slugName(label), [...existing, ...servers].map((s) => s.name));
    const base = { id: newId(), name, enabled: v.disabled !== true && v.enabled !== false, scope: "global" as const, alwaysAllow: false, allowedTools: [], readOnlyTools: [] };
    const url = v.url ?? v.serverUrl;
    let server: McpServer;
    if (typeof url === "string") {
      const headers = kvFrom(v.headers, "header");
      if (!headers) {
        errors.push({ name: label, code: "headerName" });
        continue;
      }
      server = { ...base, transport: "http", url, headers, ...(type === "sse" ? { httpTransport: "sse" as const } : type === "http" || type === "streamable-http" || type === "streamablehttp" ? { httpTransport: "streamable" as const } : {}) };
    } else if (typeof v.command === "string") {
      let command = v.command.trim();
      let args: unknown = v.args ?? [];
      // Some configs put the whole command line in `command`; split it on spaces only when no args are given.
      if (v.args === undefined && /\s/.test(command)) [command, ...(args as string[])] = command.split(/\s+/);
      if (!Array.isArray(args) || args.some((a) => typeof a !== "string" && typeof a !== "number")) {
        errors.push({ name: label, code: "args" });
        continue;
      }
      const env = kvFrom(v.env, "env");
      if (!env) {
        errors.push({ name: label, code: "envKey" });
        continue;
      }
      server = { ...base, transport: "stdio", command, args: args.map(String), env, ...(typeof v.cwd === "string" && v.cwd ? { cwd: v.cwd } : {}) };
    } else {
      errors.push({ name: label, code: "command" });
      continue;
    }
    const problems = validateServer(server, [...existing, ...servers]);
    if (problems.length) {
      errors.push({ name: label, code: problems[0] });
      continue;
    }
    servers.push(server);
  }
  return { servers, errors };
}

/** A new, empty server for the add form. */
export const blankServer = (id: string, transport: "stdio" | "http"): McpServer => {
  const base = { id, name: "", enabled: true, scope: "global" as const, alwaysAllow: false, allowedTools: [], readOnlyTools: [] };
  return transport === "stdio" ? { ...base, transport, command: "", args: [], env: [] } : { ...base, transport, url: "", headers: [] };
};
