import {
  PROTOCOL_VERSION,
  type ApiError,
  type ApprovalDecision,
  type ApprovalResponse,
  type ChatMessage,
  type ChatSummary,
  type PairRequest,
  type PairResponse,
  type PairingQrPayload,
  type ProjectSummary,
  type SendMessageRequest,
  type ServerEvent,
} from "@mcode/protocol";
import { backoffDelay } from "../lib/backoff.ts";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "closed";

/**
 * What every screen talks to. `MCodeClient` (real desktop over HTTPS + WebSocket) and `MockServer` (in memory) implement it.
 * The REST paths used by `MCodeClient` are an assumption until the desktop server exists (TASKS.md, "Desktop server").
 */
export interface DesktopApi {
  listProjects(): Promise<ProjectSummary[]>;
  listChats(projectId: number): Promise<ChatSummary[]>;
  listMessages(chatId: number): Promise<ChatMessage[]>;
  sendMessage(chatId: number, req: SendMessageRequest): Promise<void>;
  stop(chatId: number): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Opens the event stream (idempotent). Events and connection changes are delivered to the subscribers below. */
  connect(): void;
  close(): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
  onConnection(listener: (state: ConnectionState) => void): () => void;
}

/**
 * Certificate pinning hook. The native module that checks the server certificate's SHA-256 fingerprint (taken from the pairing
 * QR) against the TLS handshake is FUTURE WORK; screens and the client only depend on this interface. Until it exists,
 * `unpinnedTransport` is used and the connection is NOT protected against a man in the middle.
 */
export interface PinnedTransport {
  /** Like `fetch`, but must fail when the server certificate's fingerprint differs from `fingerprint` (lowercase hex). */
  fetch(url: string, init: RequestInit, fingerprint: string): Promise<Response>;
  /** Like `new WebSocket`, with the same pin check. React Native's WebSocket accepts `headers` as a third argument. */
  createWebSocket(url: string, fingerprint: string, headers: Record<string, string>): WebSocket;
}

export const unpinnedTransport: PinnedTransport = {
  fetch: (url, init) => fetch(url, init),
  createWebSocket: (url, _fingerprint, headers) => {
    // React Native extension: the third constructor argument carries headers; the DOM typings do not know it.
    const Ctor = WebSocket as unknown as new (url: string, protocols?: string | string[], options?: { headers: Record<string, string> }) => WebSocket;
    return new Ctor(url, undefined, { headers });
  },
};

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiError["code"] | "network",
    message: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  host: string;
  port: number;
  /** Pinned certificate fingerprint (lowercase hex). */
  fingerprint: string;
  /** Per-device bearer token from the pairing exchange. */
  token: string;
  transport?: PinnedTransport;
}

const baseUrl = (host: string, port: number) => `https://${host.includes(":") ? `[${host}]` : host}:${port}`;

async function request<T>(transport: PinnedTransport, url: string, fingerprint: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await transport.fetch(url, init, fingerprint);
  } catch (e) {
    throw new ApiRequestError(0, "network", e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    let body: Partial<ApiError> = {};
    try {
      body = (await res.json()) as Partial<ApiError>;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, body.code ?? "internal", body.message ?? `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** `POST /pair`: trades the one-time code from the QR for a device token. No token yet, so no auth header. */
export function pairWithDesktop(
  payload: PairingQrPayload,
  deviceName: string,
  transport: PinnedTransport = unpinnedTransport,
): Promise<PairResponse> {
  const body: PairRequest = { protocol: PROTOCOL_VERSION, code: payload.code, deviceName };
  return request<PairResponse>(transport, `${baseUrl(payload.host, payload.port)}/pair`, payload.fingerprint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export class MCodeClient implements DesktopApi {
  private readonly transport: PinnedTransport;
  private readonly base: string;
  private readonly listeners = new Set<(e: ServerEvent) => void>();
  private readonly connListeners = new Set<(s: ConnectionState) => void>();
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private wanted = false;

  constructor(private readonly opts: ClientOptions) {
    this.transport = opts.transport ?? unpinnedTransport;
    this.base = baseUrl(opts.host, opts.port);
  }

  private get headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" };
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return request<T>(this.transport, this.base + path, this.opts.fingerprint, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  listProjects = () => this.call<ProjectSummary[]>("GET", "/projects");
  listChats = (projectId: number) => this.call<ChatSummary[]>("GET", `/projects/${projectId}/chats`);
  listMessages = (chatId: number) => this.call<ChatMessage[]>("GET", `/chats/${chatId}/messages`);
  sendMessage = (chatId: number, req: SendMessageRequest) => this.call<void>("POST", `/chats/${chatId}/messages`, req);
  stop = (chatId: number) => this.call<void>("POST", `/chats/${chatId}/stop`);
  resolveApproval = (approvalId: string, decision: ApprovalDecision) =>
    this.call<void>("POST", `/approvals/${encodeURIComponent(approvalId)}`, { decision } satisfies ApprovalResponse);

  subscribe(listener: (e: ServerEvent) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  onConnection(listener: (s: ConnectionState) => void) {
    this.connListeners.add(listener);
    return () => void this.connListeners.delete(listener);
  }

  private setState(s: ConnectionState) {
    for (const l of this.connListeners) l(s);
  }

  connect(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.open();
  }

  close(): void {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.setState("closed");
  }

  private open() {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const url = `${this.base.replace(/^https/, "wss")}/events`;
    const ws = this.transport.createWebSocket(url, this.opts.fingerprint, { authorization: `Bearer ${this.opts.token}` });
    this.socket = ws;
    ws.onmessage = (m) => {
      try {
        const event = JSON.parse(String(m.data)) as ServerEvent;
        if (event.type === "hello") {
          if (event.protocol !== PROTOCOL_VERSION) return this.close();
          this.attempt = 0;
          this.setState("connected");
        }
        for (const l of this.listeners) l(event);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws || !this.wanted) return;
      this.socket = null;
      this.setState("reconnecting");
      this.timer = setTimeout(() => {
        this.timer = null;
        this.attempt++;
        if (this.wanted) this.open();
      }, backoffDelay(this.attempt));
    };
    ws.onerror = () => {
      /* onclose follows and schedules the retry */
    };
  }
}
