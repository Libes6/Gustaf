// JSON-RPC 2.0 framing and parsing for MCP over streamable HTTP (JSON bodies and text/event-stream). The stdio framing
// lives in src-tauri/src/mcp.rs. Pure: unit-tested in tests/mcp.test.mjs.

export const PROTOCOL_VERSION = "2025-06-18";
/** Versions this client can talk; a server answering another one is refused. */
export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_OUTGOING_BYTES = 4 * 1024 * 1024;

export type RpcId = number | string;
export type Parsed =
  | { kind: "response"; id: RpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { kind: "request"; id: RpcId; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "invalid"; reason: string };

export const request = (id: RpcId, method: string, params?: unknown) => ({ jsonrpc: "2.0" as const, id, method, ...(params === undefined ? {} : { params }) });
export const notification = (method: string, params?: unknown) => ({ jsonrpc: "2.0" as const, method, ...(params === undefined ? {} : { params }) });
export const resultReply = (id: RpcId, result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
export const errorReply = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });

/** Serializes one outgoing message; refuses messages over the size cap. */
export function encode(msg: object): string {
  const text = JSON.stringify(msg);
  if (new TextEncoder().encode(text).length > MAX_OUTGOING_BYTES) throw new Error(`MCP request exceeds ${MAX_OUTGOING_BYTES >> 20} MB`);
  return text;
}

const isId = (v: unknown): v is RpcId => (typeof v === "number" && Number.isFinite(v)) || typeof v === "string";

/** Classifies one decoded JSON-RPC message. */
export function classify(msg: unknown): Parsed {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { kind: "invalid", reason: "not an object" };
  const m = msg as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return { kind: "invalid", reason: "missing jsonrpc 2.0" };
  const method = typeof m.method === "string" ? m.method : undefined;
  if (method !== undefined) {
    if (m.id === undefined || m.id === null) return { kind: "notification", method, ...(m.params !== undefined ? { params: m.params } : {}) };
    if (!isId(m.id)) return { kind: "invalid", reason: "bad id" };
    return { kind: "request", id: m.id, method, ...(m.params !== undefined ? { params: m.params } : {}) };
  }
  if (!isId(m.id)) return { kind: "invalid", reason: "response without id" };
  if (m.error !== undefined) {
    const e = m.error as Record<string, unknown> | null;
    if (!e || typeof e !== "object") return { kind: "invalid", reason: "bad error" };
    return { kind: "response", id: m.id, error: { code: typeof e.code === "number" ? e.code : 0, message: typeof e.message === "string" ? e.message : "unknown error", ...(e.data !== undefined ? { data: e.data } : {}) } };
  }
  if (!("result" in m)) return { kind: "invalid", reason: "response without result or error" };
  return { kind: "response", id: m.id, result: m.result };
}

/** Parses a JSON body (one message or a batch array) into classified messages. */
export function parseBody(text: string): Parsed[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [{ kind: "invalid", reason: "not JSON" }];
  }
  return (Array.isArray(data) ? data : [data]).slice(0, 1000).map(classify);
}

export const errorText = (e: { code: number; message: string }) => `MCP error ${e.code}: ${String(e.message).slice(0, 2000)}`;

/**
 * Incremental text/event-stream decoder: feed it decoded text, get back the `data` payloads of complete events.
 * An event (or an unterminated tail) over `maxEvent` characters throws instead of growing without bound.
 */
export class SseDecoder {
  private buf = "";
  private maxEvent: number;
  constructor(maxEvent = MAX_MESSAGE_BYTES) {
    this.maxEvent = maxEvent;
  }
  push(chunk: string): string[] {
    this.buf += chunk.replace(/\r\n?/g, "\n");
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (block.length > this.maxEvent) throw new Error(`MCP event exceeded ${this.maxEvent >> 20} MB`);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)))
        .join("\n");
      if (data) out.push(data);
    }
    if (this.buf.length > this.maxEvent) throw new Error(`MCP event exceeded ${this.maxEvent >> 20} MB`);
    return out;
  }
}

export const initializeParams = (version: string) => ({
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: "Gustaf", version },
});

/** Checks an `initialize` result and returns the parts the client keeps. */
export function checkInitialize(result: unknown): { protocolVersion: string; serverInfo?: { name?: string; version?: string }; capabilities: Record<string, unknown>; instructions?: string } {
  if (!result || typeof result !== "object") throw new Error("invalid initialize result");
  const r = result as Record<string, any>;
  if (typeof r.protocolVersion !== "string") throw new Error("invalid initialize result (no protocolVersion)");
  if (!SUPPORTED_VERSIONS.includes(r.protocolVersion)) throw new Error(`unsupported MCP protocol version ${r.protocolVersion.slice(0, 40)}`);
  const info = r.serverInfo && typeof r.serverInfo === "object" ? { name: typeof r.serverInfo.name === "string" ? r.serverInfo.name.slice(0, 200) : undefined, version: typeof r.serverInfo.version === "string" ? r.serverInfo.version.slice(0, 100) : undefined } : undefined;
  return {
    protocolVersion: r.protocolVersion,
    ...(info ? { serverInfo: info } : {}),
    capabilities: r.capabilities && typeof r.capabilities === "object" ? r.capabilities : {},
    ...(typeof r.instructions === "string" ? { instructions: r.instructions.slice(0, 4000) } : {}),
  };
}

/** Answer to a request the server sent us: ping and roots/list are harmless, everything else is not offered. */
export function answerServerRequest(p: Extract<Parsed, { kind: "request" }>) {
  if (p.method === "ping") return resultReply(p.id, {});
  if (p.method === "roots/list") return resultReply(p.id, { roots: [] });
  return errorReply(p.id, -32601, `Method not found: ${p.method.slice(0, 100)}`);
}
