// MCP client over streamable HTTP: POSTs JSON-RPC, reads either a JSON body or a text/event-stream, keeps the
// `Mcp-Session-Id` and `MCP-Protocol-Version` headers, re-initializes once when the session expired (404).
// `fetch` is injected (the app passes Tauri's HTTP plugin; tests pass a fake), so this file has no Tauri imports.
import { SIGN_IN_NEEDED } from "./oauth";
import { answerServerRequest, checkInitialize, encode, errorText, initializeParams, MAX_MESSAGE_BYTES, notification, parseBody, request, SseDecoder, type Parsed, type RpcId } from "./protocol";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type InitInfo = ReturnType<typeof checkInitialize>;
export type HttpOptions = {
  url: string;
  headers: Record<string, string>;
  fetch: FetchLike;
  clientVersion?: string;
  /** Server notifications seen in any response stream (e.g. notifications/tools/list_changed). */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * OAuth: `header()` gives the current `Authorization` value (refreshing an expired token first) and `refresh()` is
   * called once after a 401 to obtain a new one; it returns false when the user has to sign in again.
   */
  auth?: { header: () => Promise<string | undefined>; refresh: () => Promise<boolean> };
};

class SessionExpired extends Error {}
class Unauthorized extends Error {}
/** A non-2xx answer of the server. `initialize` is set when it answered the initialize POST (the transport auto-detect looks at it). */
export class HttpStatusError extends Error {
  status: number;
  initialize = false;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
/**
 * What the runtime needs from a remote transport: streamable HTTP (`McpHttpClient`) and the legacy HTTP+SSE transport
 * (`McpSseClient`, sse.ts) both provide it.
 */
export type RemoteClient = Pick<McpHttpClient, "connect" | "request" | "close" | "info" | "toolsEpoch" | "resourcesEpoch" | "promptsEpoch">;
/** Statuses of the initialize POST after which the server is probed as a legacy SSE server (not auth, rate limit or timeout answers). */
export const isLegacySseHint = (e: unknown): e is HttpStatusError => e instanceof HttpStatusError && e.initialize && e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status);
export const abortError = () => new DOMException("Aborted", "AbortError");

export async function readText(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new Error(`MCP response exceeded ${max >> 20} MB`);
      text += dec.decode(value, { stream: true });
    }
    return text + dec.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
}

export class McpHttpClient {
  private o: HttpOptions;
  private session?: string;
  private version?: string;
  private nextId = 1;
  private connecting?: Promise<InitInfo>;
  info?: InitInfo;
  /** Bumped on notifications/tools/list_changed, resources/list_changed and prompts/list_changed. */
  toolsEpoch = 0;
  resourcesEpoch = 0;
  promptsEpoch = 0;

  constructor(o: HttpOptions) {
    this.o = o;
  }

  /** Runs the initialize handshake once; a failure lets the next call try again. */
  connect(timeoutMs = 30_000): Promise<InitInfo> {
    this.connecting ??= (async () => {
      const result = await this.post(request(this.nextId++, "initialize", initializeParams(this.o.clientVersion ?? "0")), timeoutMs).catch((e) => {
        if (e instanceof HttpStatusError) e.initialize = true;
        throw e;
      });
      const info = checkInitialize(result);
      this.version = info.protocolVersion;
      this.info = info;
      await this.post(notification("notifications/initialized"), timeoutMs);
      return info;
    })().catch((e) => {
      this.connecting = undefined;
      this.session = undefined;
      throw e;
    });
    return this.connecting;
  }

  async request(method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<unknown> {
    await this.connect();
    try {
      return await this.post(request(this.nextId++, method, params), timeoutMs, signal);
    } catch (e) {
      if (!(e instanceof SessionExpired)) throw e;
      this.connecting = undefined;
      this.session = undefined;
      await this.connect();
      return this.post(request(this.nextId++, method, params), timeoutMs, signal);
    }
  }

  /** Ends the session on the server (best effort). */
  async close() {
    const session = this.session;
    this.connecting = undefined;
    this.session = undefined;
    if (!session) return;
    await this.o.fetch(this.o.url, { method: "DELETE", headers: { ...this.o.headers, "Mcp-Session-Id": session } }).then((r) => r.body?.cancel()).catch(() => {});
  }

  private handle(p: Parsed) {
    if (p.kind === "notification") {
      if (p.method === "notifications/tools/list_changed") this.toolsEpoch++;
      else if (p.method === "notifications/resources/list_changed") this.resourcesEpoch++;
      else if (p.method === "notifications/prompts/list_changed") this.promptsEpoch++;
      this.o.onNotification?.(p.method, p.params);
    } else if (p.kind === "request") {
      this.post(answerServerRequest(p), 10_000).catch(() => {});
    }
  }

  /**
   * Sends one message. For a request, resolves with its result (or throws its error); otherwise resolves when accepted.
   * An abort returns at once (even if the transport ignores the signal) and, for a request the server may still be
   * working on, tells it with `notifications/cancelled`; whatever the server answers later is never read.
   */
  private async post(msg: { id?: RpcId; method?: string }, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const expect = "method" in msg && msg.id !== undefined ? msg.id : undefined;
    let stop: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      const fire = () => {
        if (expect !== undefined && msg.method !== "initialize" && this.session) {
          // Best effort and not awaited; the caller must not wait for the server.
          this.postOnce(notification("notifications/cancelled", { requestId: expect, reason: "cancelled by the user" }), 5_000).catch(() => {});
        }
        reject(abortError());
      };
      if (signal.aborted) return fire();
      signal.addEventListener("abort", fire, { once: true });
      stop = () => signal.removeEventListener("abort", fire);
    });
    aborted.catch(() => {});
    try {
      return await Promise.race([this.postAuthorized(msg, timeoutMs, signal), aborted]);
    } finally {
      stop?.();
    }
  }

  /** `postOnce`, and after a 401 (OAuth only) one retry with a refreshed token. */
  private async postAuthorized(msg: { id?: RpcId; method?: string }, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.postOnce(msg, timeoutMs, signal);
    } catch (e) {
      if (!(e instanceof Unauthorized) || !this.o.auth) throw e;
      if (!(await this.o.auth.refresh())) throw new Error(SIGN_IN_NEEDED);
      try {
        return await this.postOnce(msg, timeoutMs, signal);
      } catch (e2) {
        if (e2 instanceof Unauthorized) throw new Error(SIGN_IN_NEEDED);
        throw e2;
      }
    }
  }

  private async postOnce(msg: { id?: RpcId; method?: string }, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const expect = "method" in msg && msg.id !== undefined ? msg.id : undefined;
    const what = msg.method ?? "reply";
    try {
      const bearer = await this.o.auth?.header();
      const headers: Record<string, string> = {
        ...this.o.headers,
        ...(bearer ? { Authorization: bearer } : {}),
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
        ...(this.version ? { "MCP-Protocol-Version": this.version } : {}),
      };
      const res = await this.o.fetch(this.o.url, { method: "POST", headers, body: encode(msg), signal: ctl.signal });
      if (res.status === 404 && this.session && msg.method !== "initialize") {
        res.body?.cancel().catch(() => {});
        throw new SessionExpired("MCP session expired");
      }
      if (res.status === 401 && this.o.auth) {
        res.body?.cancel().catch(() => {});
        throw new Unauthorized(SIGN_IN_NEEDED);
      }
      if (!res.ok) {
        const text = (await readText(res, 64 * 1024).catch(() => "")).slice(0, 500);
        throw new HttpStatusError(res.status, `MCP server answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the authorization headers)" : ""}${text ? `: ${text}` : ""}`);
      }
      const sid = res.headers.get("mcp-session-id");
      if (sid && msg.method === "initialize") this.session = sid.slice(0, 1024);
      if (expect === undefined) {
        res.body?.cancel().catch(() => {});
        return undefined;
      }
      const type = res.headers.get("content-type") ?? "";
      const settle = (list: Parsed[]): { done: true; value: unknown } | null => {
        for (const p of list) {
          if (p.kind === "response" && p.id === expect) {
            if (p.error) throw new Error(errorText(p.error));
            return { done: true, value: p.result };
          }
          this.handle(p);
        }
        return null;
      };
      if (type.includes("text/event-stream")) {
        if (!res.body) throw new Error("MCP server sent an empty event stream");
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const sse = new SseDecoder(MAX_MESSAGE_BYTES);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const data of sse.push(dec.decode(value, { stream: true }))) {
              const r = settle(parseBody(data));
              if (r) return r.value;
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        throw new Error(`MCP server closed the stream without answering ${what}`);
      }
      const r = settle(parseBody(await readText(res, MAX_MESSAGE_BYTES)));
      if (r) return r.value;
      throw new Error(`MCP server did not answer ${what}`);
    } catch (e) {
      if (timedOut) throw new Error(`MCP request ${what} timed out after ${Math.round(timeoutMs / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
