// MCP client over the legacy HTTP+SSE transport (protocol 2024-11-05, kept by many servers): the client opens
// `GET <url>` as a long-lived text/event-stream, the first event is `endpoint` (the URL to POST messages to), every
// JSON-RPC message goes out as a POST to that endpoint (answered 202 without a body) and every answer or notification
// comes back as a `message` event on the stream. Same shape as `McpHttpClient` (http.ts) so the runtime can use either:
// `connect`, `request`, `close`, the epochs; the same injected `fetch`, timeouts, cancellation (`notifications/cancelled`,
// the late answer is never read) and OAuth hooks (a 401 refreshes once). The POST endpoint must be on the same origin as
// the stream URL: a server cannot redirect messages (and the bearer token) to another host.
import { SIGN_IN_NEEDED } from "./oauth";
import { abortError, HttpStatusError, readText, type HttpOptions, type InitInfo } from "./http";
import { answerServerRequest, checkInitialize, encode, errorText, initializeParams, MAX_MESSAGE_BYTES, notification, parseBody, request, SseDecoder, type Parsed, type RpcId } from "./protocol";

class StreamClosed extends Error {}
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class McpSseClient {
  private o: HttpOptions;
  private nextId = 1;
  private connecting?: Promise<InitInfo>;
  private pending = new Map<RpcId, Pending>();
  private endpoint?: string;
  private ctl?: AbortController;
  /** Incremented whenever a stream is opened or dropped; events of an older stream are ignored. */
  private generation = 0;
  private waiting?: { resolve: (url: string) => void; reject: (e: unknown) => void };
  info?: InitInfo;
  toolsEpoch = 0;
  resourcesEpoch = 0;
  promptsEpoch = 0;

  constructor(o: HttpOptions) {
    this.o = o;
  }

  /** Opens the stream, waits for the `endpoint` event and runs the initialize handshake; a failure lets the next call try again. */
  connect(timeoutMs = 30_000): Promise<InitInfo> {
    this.connecting ??= (async () => {
      await this.open(timeoutMs);
      const result = await this.rpc("initialize", initializeParams(this.o.clientVersion ?? "0"), timeoutMs);
      const info = checkInitialize(result);
      this.info = info;
      await this.post(notification("notifications/initialized"), timeoutMs);
      return info;
    })().catch((e) => {
      this.drop(e);
      throw e;
    });
    return this.connecting;
  }

  async request(method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<unknown> {
    await this.connect();
    return this.rpc(method, params, timeoutMs, signal);
  }

  /** Closes the stream (there is no session to end on the server). */
  async close() {
    this.drop(new StreamClosed("MCP connection closed"));
  }

  // ---- the stream ---------------------------------------------------------------------------------------------------

  private async open(timeoutMs: number): Promise<void> {
    const ctl = new AbortController();
    const gen = ++this.generation;
    this.ctl = ctl;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);
    try {
      const res = await this.getStream(ctl.signal);
      const type = res.headers.get("content-type") ?? "";
      if (!type.includes("text/event-stream") || !res.body) {
        res.body?.cancel().catch(() => {});
        throw new Error(`MCP server did not open an event stream (content-type ${type.slice(0, 60) || "missing"})`);
      }
      const endpoint = new Promise<string>((resolve, reject) => (this.waiting = { resolve, reject }));
      endpoint.catch(() => {});
      void this.pump(res.body.getReader(), gen);
      this.endpoint = await endpoint;
    } catch (e) {
      if (timedOut) throw new Error(`MCP server did not send its message endpoint within ${Math.round(timeoutMs / 1000)} s`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `GET` of the stream URL; after a 401 (OAuth only) once more with a refreshed token. */
  private async getStream(signal: AbortSignal): Promise<Response> {
    const attempt = async () => {
      const bearer = await this.o.auth?.header();
      return this.o.fetch(this.o.url, { method: "GET", headers: { ...this.o.headers, ...(bearer ? { Authorization: bearer } : {}), Accept: "text/event-stream", "Cache-Control": "no-cache" }, signal });
    };
    let res = await attempt();
    if (res.status === 401 && this.o.auth) {
      res.body?.cancel().catch(() => {});
      if (!(await this.o.auth.refresh())) throw new Error(SIGN_IN_NEEDED);
      res = await attempt();
      if (res.status === 401) {
        res.body?.cancel().catch(() => {});
        throw new Error(SIGN_IN_NEEDED);
      }
    }
    if (!res.ok) {
      const text = (await readText(res, 64 * 1024).catch(() => "")).slice(0, 500);
      throw new HttpStatusError(res.status, `MCP server answered HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (check the authorization headers)" : ""}${text ? `: ${text}` : ""}`);
    }
    return res;
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>, gen: number) {
    const dec = new TextDecoder();
    const sse = new SseDecoder(MAX_MESSAGE_BYTES);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of sse.pushEvents(dec.decode(value, { stream: true }))) this.onEvent(gen, ev);
      }
      if (gen === this.generation) this.drop(new StreamClosed("the MCP server closed the event stream"));
    } catch (e) {
      if (gen === this.generation) this.drop(e instanceof Error ? e : new Error(String(e)));
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  private onEvent(gen: number, ev: { event: string; data: string }) {
    if (gen !== this.generation) return;
    if (ev.event === "endpoint") {
      if (!this.waiting) return; // only the first one counts
      const w = this.waiting;
      this.waiting = undefined;
      try {
        const base = new URL(this.o.url);
        const target = new URL(ev.data.trim(), base);
        if (target.origin !== base.origin || target.username || target.password) throw new Error("the MCP server sent a message endpoint on another origin");
        w.resolve(target.toString());
      } catch (e) {
        w.reject(e instanceof Error ? e : new Error("invalid MCP message endpoint"));
      }
      return;
    }
    if (ev.event !== "message") return;
    for (const p of parseBody(ev.data)) this.handle(p);
  }

  private handle(p: Parsed) {
    if (p.kind === "response") {
      const w = this.pending.get(p.id);
      if (!w) return; // late answer of a cancelled or timed-out request
      if (p.error) w.reject(new Error(errorText(p.error)));
      else w.resolve(p.result);
    } else if (p.kind === "notification") {
      if (p.method === "notifications/tools/list_changed") this.toolsEpoch++;
      else if (p.method === "notifications/resources/list_changed") this.resourcesEpoch++;
      else if (p.method === "notifications/prompts/list_changed") this.promptsEpoch++;
      this.o.onNotification?.(p.method, p.params);
    } else if (p.kind === "request") {
      this.post(answerServerRequest(p), 10_000).catch(() => {});
    }
  }

  /** Forgets the stream: aborts it, fails every request still waiting, and lets the next call reconnect. */
  private drop(reason: unknown) {
    this.generation++;
    const ctl = this.ctl;
    this.ctl = undefined;
    this.endpoint = undefined;
    this.connecting = undefined;
    ctl?.abort();
    const waiting = this.waiting;
    this.waiting = undefined;
    const err = reason instanceof Error ? reason : new Error(String(reason));
    waiting?.reject(err);
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) p.reject(err);
  }

  // ---- requests -----------------------------------------------------------------------------------------------------

  /**
   * Sends a request and resolves with its answer from the stream. A timeout or an abort returns at once and, for a
   * request other than `initialize`, tells the server with `notifications/cancelled`; a later answer is never read.
   */
  private rpc(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let done = false;
      const finish = (f: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        f();
      };
      const cancelled = (reason: string) => {
        if (method !== "initialize" && this.endpoint) this.post(notification("notifications/cancelled", { requestId: id, reason }), 5_000).catch(() => {});
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`MCP request ${method} timed out after ${Math.round(timeoutMs / 1000)} s`)));
        cancelled("timed out");
      }, timeoutMs);
      const onAbort = () => {
        finish(() => reject(abortError()));
        cancelled("cancelled by the user");
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve: (v) => finish(() => resolve(v)), reject: (e) => finish(() => reject(e)) });
      this.post(request(id, method, params), timeoutMs, signal).catch((e) => finish(() => reject(e)));
    });
  }

  /** POSTs one message to the endpoint (any 2xx is accepted, the body is ignored); after a 401 (OAuth only) once more with a fresh token. */
  private async post(msg: object, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new StreamClosed("MCP event stream is not open");
    const once = async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const onAbort = () => ctl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const bearer = await this.o.auth?.header();
        const res = await this.o.fetch(endpoint, { method: "POST", headers: { ...this.o.headers, ...(bearer ? { Authorization: bearer } : {}), "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: encode(msg), signal: ctl.signal });
        if (res.ok) {
          res.body?.cancel().catch(() => {});
          return res.status;
        }
        if (res.status === 401 && this.o.auth) {
          res.body?.cancel().catch(() => {});
          return 401;
        }
        const text = (await readText(res, 64 * 1024).catch(() => "")).slice(0, 500);
        throw new HttpStatusError(res.status, `MCP server answered HTTP ${res.status}${res.status === 403 ? " (check the authorization headers)" : ""}${text ? `: ${text}` : ""}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    };
    if ((await once()) !== 401) return;
    if (!(await this.o.auth!.refresh())) throw new Error(SIGN_IN_NEEDED);
    if ((await once()) === 401) throw new Error(SIGN_IN_NEEDED);
  }
}
