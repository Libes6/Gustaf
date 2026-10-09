// A small Agent Client Protocol client (agentclientprotocol.com, JSON-RPC 2.0 over stdio), generic on purpose: Antigravity
// is the first agent that uses it, other ACP agents (Gemini CLI...) can be added without touching this file.
//
// What it does: `initialize`, `authenticate`, `session/new|load|resume`, `session/set_config_option`, `session/prompt`
// with the agent's `session/update` stream, `session/cancel`, and the requests an agent sends to the client:
// `session/request_permission` (answered by the injected `permission` handler) and, only when a host is injected,
// `fs/read_text_file` / `fs/write_text_file` (confined to the project root, see fsPolicy.ts). `terminal/*` is NOT
// supported: the client advertises `terminal: false` and answers those methods with "method not found".
// The wire is injected (`Duplex`), so tests run it against an in-memory fake agent.
// Ideas adapted from T3 Code's ACP runtime (MIT, github.com/pingdotgg/t3code, apps/server/src/provider/acp).
import { confineToRoot } from "./fsPolicy.ts";
import { AcpError, createConnection, isRecord, RPC, type Duplex, type Json } from "./rpc.ts";

/**
 * Two protocol generations exist in the wild (ACP v1 and the v2 draft) and agents mix them: Google's Antigravity reports
 * `protocolVersion: 2` with the v1 `agentInfo`/`agentCapabilities` response shape. So the client sends ONE `initialize`
 * that carries the fields of both generations and decides the generation from the SHAPE of the answer (`info` present =
 * v2), never from the number. Everything after that (method names, session setup, prompt completion, permission
 * requests, config options) is normalised to one internal shape. Differences handled, v1 -> v2: `authenticate` ->
 * `auth/login` (`logout` -> `auth/logout`); `session/load` -> `session/resume` with `replayFrom`; the prompt response
 * only acknowledges and the end arrives as `state_update` idle (with stop reason and usage); config options use `configId`
 * and `set_config_option` takes `type: "id"`; permission requests carry a `subject` instead of `toolCall`; `tool_call` is
 * folded into `tool_call_update` plus `tool_call_content_chunk`; `plan` is `plan_update`. Modelled on T3 Code's effect-acp
 * client (MIT, github.com/pingdotgg/t3code, packages/effect-acp/src/client.ts). Both generations are exercised only
 * against synthetic fixtures (tests/acpClient.test.mjs), never against a real agent.
 */
export const PROTOCOL_VERSION = 1;
/** The version number offered for the v2 side of the negotiating request. */
export const PROTOCOL_VERSION_V2 = 2;
export type Generation = 1 | 2;

/** A v2 initialize answer has `info`; a v1 one has `agentInfo` (whatever its `protocolVersion` says). */
export const isV2Initialize = (r: unknown): boolean => isRecord(r) && "info" in r && !("agentInfo" in r);

export type AuthMethod = { id: string; name: string; description?: string };
export type AgentCapabilities = {
  loadSession: boolean;
  /** `session/resume` (continue without replaying the history). */
  resume: boolean;
  image: boolean;
  embeddedContext: boolean;
  /** The agent has a `logout` request. */
  logout: boolean;
};
export type InitializeResult = {
  protocolVersion: number;
  capabilities: AgentCapabilities;
  authMethods: AuthMethod[];
  agentInfo?: { name?: string; title?: string; version?: string };
};

export type ConfigChoice = { value: string; name: string; description?: string };
/** A select-type session config option (`model`, `mode`, `thought_level`...). */
export type ConfigOption = {
  id: string;
  name: string;
  category?: string;
  currentValue: string;
  options: ConfigChoice[];
};
export type SessionSetup = {
  sessionId: string;
  configOptions: ConfigOption[];
  /** The legacy `models` block some agents still send instead of a `model` config option. */
  models?: { current?: string; available: { id: string; name: string }[] };
};

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
export type PromptUsage = {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
};
export type PromptResult = { stopReason: StopReason; usage?: PromptUsage };

export type PermissionOption = { optionId: string; name: string; kind: string };
export type PermissionRequest = {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PermissionOption[];
  /** Plain text of the tool call's content (a diff summary, the command...), bounded. */
  detail: string;
};
export type PermissionAnswer = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/** Files the agent may read and write through the client, relative to `root` (see fsPolicy.ts). */
export type FsHost = {
  root: string;
  read(relPath: string, o: { line?: number; limit?: number }): Promise<string>;
  write(relPath: string, content: string): Promise<void>;
};

export type ClientOptions = {
  duplex: Duplex;
  clientInfo?: { name: string; title?: string; version: string };
  fs?: FsHost;
  permission(req: PermissionRequest): Promise<PermissionAnswer>;
  /** A valid `session/update` (`update` is the agent's raw object, interpreted by updates.ts). */
  onUpdate(sessionId: string, update: Json): void;
  requestTimeoutMs?: number;
  /** Strings never to show in error messages (API keys). */
  redact?: () => string[];
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const MAX_FILE = 5 * 1024 * 1024;

/** A v2 initialize answer rewritten in the v1 shape (so one parser serves both). */
function v1Shape(r: Json): Json {
  const caps = isRecord(r.capabilities) ? r.capabilities : {};
  const session = isRecord(caps.session) ? caps.session : undefined;
  const prompt = session && isRecord(session.prompt) ? session.prompt : {};
  const methods = Array.isArray(r.authMethods) ? r.authMethods : [];
  return {
    protocolVersion: r.protocolVersion,
    agentInfo: r.info,
    agentCapabilities: {
      loadSession: !!session,
      promptCapabilities: { image: prompt.image != null, embeddedContext: prompt.embeddedContext != null },
      sessionCapabilities: session ? { resume: {} } : {},
      auth: methods.length ? { logout: {} } : {},
    },
    authMethods: methods.flatMap((m) =>
      isRecord(m) ? [{ ...m, id: typeof m.methodId === "string" ? m.methodId : m.id }] : [],
    ),
  };
}

export function parseInitialize(raw: unknown): InitializeResult {
  if (!isRecord(raw)) throw new AcpError("protocol", "The agent sent an invalid initialize response");
  const r = isV2Initialize(raw) ? v1Shape(raw) : raw;
  const caps = isRecord(r.agentCapabilities) ? r.agentCapabilities : {};
  const prompt = isRecord(caps.promptCapabilities) ? caps.promptCapabilities : {};
  const session = isRecord(caps.sessionCapabilities) ? caps.sessionCapabilities : {};
  const auth = isRecord(caps.auth) ? caps.auth : {};
  const methods = Array.isArray(r.authMethods) ? r.authMethods : [];
  const info = isRecord(r.agentInfo) ? r.agentInfo : undefined;
  return {
    protocolVersion: count(r.protocolVersion) ?? PROTOCOL_VERSION,
    capabilities: {
      loadSession: caps.loadSession === true,
      resume: session.resume != null && session.resume !== false,
      image: prompt.image === true,
      embeddedContext: prompt.embeddedContext === true,
      logout: auth.logout != null && auth.logout !== false,
    },
    authMethods: methods.slice(0, 20).flatMap((m): AuthMethod[] =>
      isRecord(m) && typeof m.id === "string" && m.id && m.id.length <= 100
        ? [
            {
              id: m.id,
              name: str(m.name).slice(0, 100) || m.id,
              ...(typeof m.description === "string" ? { description: m.description.slice(0, 300) } : {}),
            },
          ]
        : [],
    ),
    ...(info
      ? {
          agentInfo: {
            name: str(info.name).slice(0, 100),
            title: str(info.title).slice(0, 100),
            version: str(info.version).slice(0, 50),
          },
        }
      : {}),
  };
}

/** Select options of a session, flat or grouped; other option types (boolean...) are skipped. */
export function parseConfigOptions(raw: unknown): ConfigOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((o): ConfigOption[] => {
    const id =
      typeof o.id === "string" && o.id ? o.id : isRecord(o) && typeof o.configId === "string" ? o.configId : "";
    if (!isRecord(o) || !id) return [];
    if (o.type !== undefined && o.type !== "select") return [];
    const flat: ConfigChoice[] = [];
    const add = (c: unknown) => {
      if (isRecord(c) && typeof c.value === "string" && c.value && flat.length < 300)
        flat.push({
          value: c.value,
          name: str(c.name).slice(0, 120) || c.value,
          ...(typeof c.description === "string" ? { description: c.description.slice(0, 300) } : {}),
        });
    };
    for (const c of Array.isArray(o.options) ? o.options : []) {
      if (isRecord(c) && Array.isArray(c.options)) c.options.forEach(add);
      else add(c);
    }
    return [
      {
        id,
        name: str(o.name) || id,
        ...(typeof o.category === "string" ? { category: o.category } : {}),
        currentValue: str(o.currentValue),
        options: flat,
      },
    ];
  });
}

function parseSession(r: unknown, sessionId?: string): SessionSetup {
  const body = isRecord(r) ? r : {};
  const id = sessionId ?? str(body.sessionId);
  if (!id || id.length > 300) throw new AcpError("protocol", "The agent did not return a session id");
  const m = isRecord(body.models) ? body.models : undefined;
  return {
    sessionId: id,
    configOptions: parseConfigOptions(body.configOptions),
    ...(m
      ? {
          models: {
            current: str(m.currentModelId) || undefined,
            available: (Array.isArray(m.availableModels) ? m.availableModels : [])
              .slice(0, 300)
              .flatMap((x) =>
                isRecord(x) && typeof x.modelId === "string" && x.modelId
                  ? [{ id: x.modelId, name: str(x.name).slice(0, 120) || x.modelId }]
                  : [],
              ),
          },
        }
      : {}),
  };
}

/** v2 permission request (`subject` instead of `toolCall`) rewritten in the v1 shape. */
function v1Permission(p: Json, requestId: string | number): Json {
  const subject = isRecord(p.subject) ? p.subject : {};
  const call = isRecord(subject.toolCall) ? subject.toolCall : undefined;
  const command = subject.type === "command";
  return {
    sessionId: p.sessionId,
    options: p.options,
    toolCall: {
      toolCallId:
        call && typeof call.toolCallId === "string"
          ? call.toolCallId
          : typeof subject.toolCallId === "string"
            ? subject.toolCallId
            : String(requestId),
      title: str(call?.title) || str(p.title),
      kind: call?.kind ?? (command ? "execute" : "other"),
      content: [
        ...(Array.isArray(call?.content) ? call.content : []),
        ...(command
          ? [
              {
                type: "content",
                content: { type: "text", text: `${str(subject.command)}\n${str(subject.cwd)}`.trim() },
              },
            ]
          : []),
        ...(typeof p.description === "string" && p.description
          ? [{ type: "content", content: { type: "text", text: p.description } }]
          : []),
      ],
    },
  };
}

function parsePermission(raw: unknown, requestId: string | number): PermissionRequest {
  const p = isRecord(raw) && !("toolCall" in raw) && isRecord(raw.subject) ? v1Permission(raw, requestId) : raw;
  const bad = () => new AcpError("rpc", "Invalid permission request", { code: RPC.params });
  if (!isRecord(p) || typeof p.sessionId !== "string" || !isRecord(p.toolCall) || !Array.isArray(p.options))
    throw bad();
  const call = p.toolCall;
  const options = p.options
    .slice(0, 20)
    .flatMap((o): PermissionOption[] =>
      isRecord(o) && typeof o.optionId === "string" && o.optionId.trim() && o.optionId.length <= 200
        ? [{ optionId: o.optionId, name: str(o.name).slice(0, 200), kind: str(o.kind) }]
        : [],
    );
  const detail: string[] = [];
  for (const c of Array.isArray(call.content) ? call.content.slice(0, 10) : []) {
    if (!isRecord(c)) continue;
    if (c.type === "diff") detail.push(`${str(c.path)}${typeof c.oldText === "string" ? "" : " (new file)"}`);
    else if (c.type === "content" && isRecord(c.content) && c.content.type === "text") detail.push(str(c.content.text));
  }
  return {
    sessionId: p.sessionId,
    toolCallId: str(call.toolCallId).slice(0, 200),
    title: str(call.title).slice(0, 300),
    ...(typeof call.kind === "string" ? { kind: call.kind } : {}),
    options,
    detail: detail.join("\n").slice(0, 2000),
  };
}

function parsePromptResult(r: unknown): PromptResult {
  const body = isRecord(r) ? r : {};
  const reasons = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"];
  const stopReason = reasons.includes(body.stopReason as string) ? (body.stopReason as StopReason) : "end_turn";
  const u = isRecord(body.usage) ? body.usage : undefined;
  const input = count(u?.inputTokens);
  const output = count(u?.outputTokens);
  return {
    stopReason,
    ...(u && input !== undefined && output !== undefined
      ? {
          usage: {
            inputTokens: input,
            outputTokens: output,
            thoughtTokens: count(u.thoughtTokens),
            cachedReadTokens: count(u.cachedReadTokens),
            cachedWriteTokens: count(u.cachedWriteTokens),
          },
        }
      : {}),
  };
}

export function createAcpClient(o: ClientOptions) {
  const fsHost = o.fs;

  const onRequest = async (method: string, params: unknown, requestId: string | number): Promise<unknown> => {
    switch (method) {
      case "session/request_permission": {
        const req = parsePermission(params, requestId);
        try {
          const a = await o.permission(req);
          // Only an option the agent offered can be selected.
          if (a.outcome === "selected" && req.options.some((x) => x.optionId === a.optionId)) return { outcome: a };
        } catch {
          /* a failing UI is a refusal to decide */
        }
        return { outcome: { outcome: "cancelled" } };
      }
      case "fs/read_text_file": {
        if (!fsHost) break;
        const p = isRecord(params) ? params : {};
        const rel = confineToRoot(fsHost.root, p.path);
        const content = await fsHost.read(rel, { line: count(p.line), limit: count(p.limit) });
        return { content: content.slice(0, MAX_FILE) };
      }
      case "fs/write_text_file": {
        if (!fsHost) break;
        const p = isRecord(params) ? params : {};
        const rel = confineToRoot(fsHost.root, p.path);
        if (typeof p.content !== "string" || p.content.length > MAX_FILE)
          throw new AcpError("rpc", "Invalid file content", { code: RPC.params });
        await fsHost.write(rel, p.content);
        return null;
      }
    }
    // `terminal/*`, `fs/*` without a host, and anything else this client does not implement.
    throw new AcpError("rpc", `Method not supported: ${method.slice(0, 80)}`, { code: RPC.notFound });
  };

  let generation: Generation = 1;
  // v2: a prompt is acknowledged by its response and finished by a `state_update` idle notification.
  const completions = new Map<string, (r: PromptResult) => void>();
  const finishV2 = (sessionId: string, update: Json) => {
    if (update.sessionUpdate !== "state_update" || update.state !== "idle") return;
    const done = completions.get(sessionId);
    if (!done) return;
    completions.delete(sessionId);
    done(parsePromptResult({ stopReason: update.stopReason ?? "end_turn", usage: update.usage }));
  };

  const conn = createConnection(o.duplex, {
    onRequest,
    onNotification(method, params) {
      if (method !== "session/update" || !isRecord(params) || typeof params.sessionId !== "string") return;
      if (!isRecord(params.update)) return;
      finishV2(params.sessionId, params.update);
      o.onUpdate(params.sessionId, params.update);
    },
    requestTimeoutMs: o.requestTimeoutMs,
    redact: o.redact,
  });

  const mcp: unknown[] = []; // MCP servers are not forwarded: the agent uses its own configuration
  const v2 = () => generation === 2;

  return {
    /** The negotiated generation (decided by the shape of the `initialize` answer). */
    get generation(): Generation {
      return generation;
    },
    async initialize(): Promise<InitializeResult> {
      const info = o.clientInfo ?? { name: "gustaf", title: "Gustaf", version: "0" };
      const clientCapabilities = { fs: { readTextFile: !!fsHost, writeTextFile: !!fsHost }, terminal: false };
      // One request, both generations' fields: a v1 agent ignores `info`/`capabilities`, a v2 agent ignores the rest.
      const raw = await conn.request("initialize", {
        protocolVersion: PROTOCOL_VERSION_V2,
        info: { name: info.name, version: info.version },
        capabilities: {},
        clientCapabilities,
        clientInfo: info,
      });
      generation = isV2Initialize(raw) ? 2 : 1;
      return parseInitialize(raw);
    },
    /** `timeoutMs`: a browser sign-in waits for the user (the caller picks the limit and may abort with `signal`). */
    async authenticate(methodId: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
      await conn.request(
        v2() ? "auth/login" : "authenticate",
        { methodId },
        { timeoutMs: opts.timeoutMs ?? o.requestTimeoutMs ?? 60_000, signal: opts.signal },
      );
    },
    async logout(): Promise<void> {
      await conn.request(v2() ? "auth/logout" : "logout", {});
    },
    async newSession(cwd: string): Promise<SessionSetup> {
      return parseSession(
        await conn.request("session/new", { cwd, mcpServers: mcp }, { timeoutMs: o.requestTimeoutMs ?? 60_000 }),
      );
    },
    /** v2 has no `session/load`: the same call is `session/resume` replaying from the start. */
    async loadSession(sessionId: string, cwd: string): Promise<SessionSetup> {
      return parseSession(
        await conn.request(
          v2() ? "session/resume" : "session/load",
          { sessionId, cwd, mcpServers: mcp, ...(v2() ? { replayFrom: { type: "start" } } : {}) },
          { timeoutMs: o.requestTimeoutMs ?? 120_000 },
        ),
        sessionId,
      );
    },
    async resumeSession(sessionId: string, cwd: string): Promise<SessionSetup> {
      return parseSession(
        await conn.request(
          "session/resume",
          { sessionId, cwd, mcpServers: mcp },
          { timeoutMs: o.requestTimeoutMs ?? 60_000 },
        ),
        sessionId,
      );
    },
    async setConfigOption(sessionId: string, configId: string, value: string): Promise<ConfigOption[]> {
      const r = await conn.request("session/set_config_option", {
        sessionId,
        configId,
        value,
        ...(v2() ? { type: "id" } : {}),
      });
      return parseConfigOptions(isRecord(r) ? r.configOptions : undefined);
    },
    /** Runs until the agent is done (no timeout); `content` are ACP content blocks. */
    async prompt(sessionId: string, content: Json[]): Promise<PromptResult> {
      if (!v2())
        return parsePromptResult(
          await conn.request("session/prompt", { sessionId, prompt: content }, { timeoutMs: 0 }),
        );
      const finished = new Promise<PromptResult>((resolve, reject) => {
        completions.set(sessionId, resolve);
        void o.duplex.closed.then(() => reject(conn.closedError ?? new AcpError("closed", "The agent process ended")));
      });
      finished.catch(() => {});
      try {
        const ack = await conn.request("session/prompt", { sessionId, prompt: content }, { timeoutMs: 0 });
        // An agent that answers with a stop reason (a v1-style answer) needs no `state_update`.
        if (isRecord(ack) && typeof ack.stopReason === "string") return parsePromptResult(ack);
        return await finished;
      } finally {
        completions.delete(sessionId);
      }
    },
    /** `session/cancel` is a notification: the pending `prompt` then ends with `stopReason: "cancelled"`. */
    cancel(sessionId: string) {
      return conn.notify("session/cancel", { sessionId });
    },
    request: (method: string, params: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }) =>
      conn.request(method, params, opts),
    close: (reason?: string) => conn.close(reason),
    get closedError() {
      return conn.closedError;
    },
  };
}

export type AcpClient = ReturnType<typeof createAcpClient>;
