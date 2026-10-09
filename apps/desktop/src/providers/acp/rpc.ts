// JSON-RPC 2.0 plumbing for the Agent Client Protocol (agentclientprotocol.com): newline-delimited JSON over an agent's
// stdio. The transport is injected (`Duplex`): the app wraps `openJsonProcess` (providers/processHost.ts), tests use an
// in-memory fake. Everything read from the agent is untrusted: a message is classified defensively and anything that is
// not a well-formed request, response or notification is dropped, never thrown on.
// Ideas adapted from T3 Code's ACP runtime (MIT, github.com/pingdotgg/t3code, apps/server/src/provider/acp).

/** What the connection needs from a process: structurally what `JsonProcess` offers. */
export interface Duplex {
  /** Writes one JSON line (a newline is added). */
  write(line: string): Promise<void>;
  /** Parsed JSON values from stdout (lines that arrived earlier are replayed). */
  onMessage(cb: (m: unknown) => void): void;
  /** Resolves with the exit code once the process is gone and its last line was delivered. */
  closed: Promise<number | null>;
  exited(): boolean;
  /** The tail of stderr, for error messages. */
  stderr(): string;
  /** Graceful stop of the whole process tree. */
  stop(graceMs?: number): Promise<void>;
}

export type AcpErrorKind = "rpc" | "timeout" | "closed" | "protocol" | "aborted";

/** The one error type of the ACP client. `code`/`data` come from a JSON-RPC error object. */
export class AcpError extends Error {
  readonly kind: AcpErrorKind;
  readonly code?: number;
  readonly method?: string;
  readonly data?: unknown;
  constructor(kind: AcpErrorKind, message: string, o: { code?: number; method?: string; data?: unknown } = {}) {
    super(message);
    this.name = "AcpError";
    this.kind = kind;
    this.code = o.code;
    this.method = o.method;
    this.data = o.data;
  }
}

export const isAcpError = (e: unknown): e is AcpError => e instanceof AcpError;

/** JSON-RPC error codes used here. */
export const RPC = { parse: -32700, invalid: -32600, notFound: -32601, params: -32602, internal: -32603 } as const;

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

type Inbound =
  | { kind: "request"; id: string | number; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | {
      kind: "response";
      id: string | number;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    }
  | { kind: "ignored" };

const isId = (v: unknown): v is string | number =>
  (typeof v === "string" && v.length > 0 && v.length <= 200) || (typeof v === "number" && Number.isFinite(v));

/** Classifies one inbound value. Never throws. */
export function classify(m: unknown): Inbound {
  if (!isRecord(m)) return { kind: "ignored" };
  if (m.jsonrpc !== undefined && m.jsonrpc !== "2.0") return { kind: "ignored" };
  if (typeof m.method === "string" && m.method) {
    if (m.id === undefined || m.id === null) return { kind: "notification", method: m.method, params: m.params };
    return isId(m.id) ? { kind: "request", id: m.id, method: m.method, params: m.params } : { kind: "ignored" };
  }
  if (isId(m.id) && ("result" in m || "error" in m)) {
    if (isRecord(m.error)) {
      const code = typeof m.error.code === "number" ? m.error.code : RPC.internal;
      const message = typeof m.error.message === "string" ? m.error.message : "Agent error";
      return { kind: "response", id: m.id, error: { code, message, data: m.error.data } };
    }
    return { kind: "response", id: m.id, result: m.result };
  }
  return { kind: "ignored" };
}

export type RequestHandler = (method: string, params: unknown, id: string | number) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export type ConnectionOptions = {
  /** Answers requests the agent sends to the client. Throw an `AcpError` with a `code` to send a JSON-RPC error. */
  onRequest: RequestHandler;
  onNotification: NotificationHandler;
  /** Default timeout of `request` (ms). */
  requestTimeoutMs?: number;
  /** Strings that must never appear in an error message (API keys): replaced by `***`. */
  redact?: () => string[];
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export type RequestOptions = {
  /** `0` or `Infinity`: no timeout (a prompt runs as long as the agent works). */
  timeoutMs?: number;
  signal?: AbortSignal;
};

export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("***");
  return out;
}

export function createConnection(duplex: Duplex, o: ConnectionOptions) {
  let nextId = 1;
  let closedError: AcpError | undefined;
  const pending = new Map<
    string | number,
    { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; done: () => void }
  >();
  const safe = (s: string) => scrub(s, o.redact?.() ?? []);

  const send = async (m: Json) => {
    try {
      await duplex.write(JSON.stringify({ jsonrpc: "2.0", ...m }));
    } catch (e) {
      throw new AcpError("closed", safe(`Could not write to the agent: ${(e as Error)?.message ?? e}`));
    }
  };

  const failAll = (err: AcpError) => {
    closedError ??= err;
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      p.done();
      p.reject(err);
    }
  };

  const answer = async (id: string | number, method: string, params: unknown) => {
    try {
      const result = await o.onRequest(method, params, id);
      await send({ id, result: result ?? null });
    } catch (e) {
      const code = isAcpError(e) && e.code !== undefined ? e.code : RPC.internal;
      // A handler's own failure text is not forwarded: it may hold paths or secrets.
      const message = isAcpError(e) && e.kind === "rpc" ? safe(e.message) : "Client request failed";
      await send({ id, error: { code, message } }).catch(() => {});
    }
  };

  duplex.onMessage((raw) => {
    const m = classify(raw);
    if (m.kind === "response") {
      const p = pending.get(m.id);
      if (!p) return; // late answer to a request that timed out or was aborted
      pending.delete(m.id);
      p.done();
      if (m.error)
        p.reject(
          new AcpError("rpc", safe(m.error.message), { code: m.error.code, method: p.method, data: m.error.data }),
        );
      else p.resolve(m.result);
    } else if (m.kind === "request") {
      void answer(m.id, m.method, m.params);
    } else if (m.kind === "notification") {
      try {
        o.onNotification(m.method, m.params);
      } catch {
        /* a notification handler must not break the stream */
      }
    }
  });

  void duplex.closed.then((code) => {
    const tail = duplex.stderr().trim().slice(-400);
    failAll(
      new AcpError(
        "closed",
        safe(`The agent process ended${code == null ? "" : ` (exit ${code})`}${tail ? `: ${tail}` : ""}`),
      ),
    );
  });

  return {
    request(method: string, params: unknown, opts: RequestOptions = {}): Promise<unknown> {
      if (closedError) return Promise.reject(closedError);
      if (opts.signal?.aborted) return Promise.reject(new AcpError("aborted", "Aborted", { method }));
      const id = nextId++;
      const ms = opts.timeoutMs ?? o.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (!pending.delete(id)) return;
          done();
          reject(new AcpError("aborted", "Aborted", { method }));
        };
        const done = () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        pending.set(id, { method, resolve, reject, done });
        if (ms > 0 && Number.isFinite(ms))
          timer = setTimeout(() => {
            if (!pending.delete(id)) return;
            done();
            reject(new AcpError("timeout", `${method} timed out after ${Math.round(ms / 1000)}s`, { method }));
          }, ms);
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        send({ id, method, params }).catch((e) => {
          if (!pending.delete(id)) return;
          done();
          reject(e);
        });
      });
    },
    notify(method: string, params: unknown): Promise<void> {
      return closedError ? Promise.resolve() : send({ method, params }).catch(() => {});
    },
    /** The process is gone or being stopped: every waiting request fails. */
    close(reason = "The agent connection was closed") {
      failAll(new AcpError("closed", reason));
    },
    get closedError() {
      return closedError;
    },
    pendingCount: () => pending.size,
  };
}

export type Connection = ReturnType<typeof createConnection>;
