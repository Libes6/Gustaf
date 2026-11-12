// @effect-diagnostics extendsNativeError:off globalDate:off globalTimers:off -- Plain socket code for React Native and Node, outside any Effect runtime.
/**
 * The phone's side of the Gustaf relay: one relay socket, one Noise channel to one computer, and
 * `fetch` / `WebSocket` look-alikes that carry HTTP requests and sockets through it.
 */
import {
  NoiseHandshake,
  type NoiseCipherState,
  type NoiseKeyPair,
  type RandomBytes,
  bytesEqual,
} from "./relayNoise.ts";
import {
  type TunnelHead,
  type TunnelMessage,
  type TunnelStatus,
  TUNNEL_CHUNK,
  TUNNEL_FLAG_FIN,
  TunnelMessageType,
  decodeRelayFrame,
  decodeTunnelMessage,
  encodeRelayFrame,
  encodeTunnelJson,
  encodeTunnelMessage,
  fromBase64Url,
  parseRelayServerMessage,
  readTunnelJson,
  relayPrologue,
  relaySocketUrl,
  tunnelFragments,
} from "./relayTunnel.ts";

export interface RelayTunnelClientOptions {
  readonly relayUrl: string;
  readonly deviceToken: string;
  readonly hostDeviceId: string;
  /** The computer's static key from the QR code, base64url. The handshake fails on any other. */
  readonly hostKey: string;
  readonly clientKeyPair: NoiseKeyPair;
  readonly name: string;
  /** Only while pairing: the QR code's one-time secret. */
  readonly pairingSecret?: string;
  readonly randomBytes: RandomBytes;
  /** Called when the computer asks its user to allow this device. */
  readonly onPending?: () => void;
  readonly createSocket?: (url: string) => WebSocket;
}

export type RelayTunnelFailure =
  | "relay_unreachable"
  | "unauthorized"
  | "host_offline"
  | "rejected"
  | "limit"
  | "handshake_failed"
  | "closed";

export class RelayTunnelClientError extends Error {
  override readonly name = "RelayTunnelClientError";
  readonly reason: RelayTunnelFailure;
  constructor(reason: RelayTunnelFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

const CHANNEL = 1;
const CONNECT_TIMEOUT_MS = 15_000;
// A suspended phone's socket dies without a close event. The tunnel pings the relay while idle and
// before new work on a quiet socket, and gives up when nothing comes back.
const KEEPALIVE_MS = 20_000;
const QUIET_BEFORE_PROBE_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

// React Native's Response cannot take a stream, so a response body is collected, then resolved.
interface PendingHttp {
  readonly resolve: (response: Response) => void;
  readonly reject: (error: Error) => void;
  head: TunnelHead | null;
  readonly body: Array<Uint8Array>;
}

/** An open, approved tunnel. Create with `RelayTunnelClient.connect`. */
export class RelayTunnelClient {
  readonly #socket: WebSocket;
  readonly #send: NoiseCipherState;
  readonly #receive: NoiseCipherState;
  readonly #http = new Map<number, PendingHttp>();
  readonly #sockets = new Map<number, RelayTunnelWebSocket>();
  readonly #closeListeners = new Set<(error: RelayTunnelClientError) => void>();
  #nextStream = 1;
  #closed: RelayTunnelClientError | null = null;
  #lastInbound = Date.now();
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #keepalive: ReturnType<typeof setInterval>;
  /** Set once, when the computer's user approved this device: a one-time code for the pairing link. */
  readonly pairingToken: string | undefined;
  readonly remoteStaticKey: Uint8Array;
  readonly localStaticKey: Uint8Array;

  private constructor(input: {
    socket: WebSocket;
    send: NoiseCipherState;
    receive: NoiseCipherState;
    pairingToken: string | undefined;
    remoteStaticKey: Uint8Array;
    localStaticKey: Uint8Array;
  }) {
    this.#socket = input.socket;
    this.#send = input.send;
    this.#receive = input.receive;
    this.pairingToken = input.pairingToken;
    this.remoteStaticKey = input.remoteStaticKey;
    this.localStaticKey = input.localStaticKey;
    this.#keepalive = setInterval(() => this.#probe(), KEEPALIVE_MS);
  }

  static connect(options: RelayTunnelClientOptions): Promise<RelayTunnelClient> {
    return new Promise((resolve, reject) => {
      const socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
        relaySocketUrl(options.relayUrl),
      );
      socket.binaryType = "arraybuffer";
      let deviceId: string | null = null;
      let handshake: NoiseHandshake | null = null;
      let session: {
        send: NoiseCipherState;
        receive: NoiseCipherState;
        remoteStaticKey: Uint8Array;
      } | null = null;
      let client: RelayTunnelClient | null = null;
      let settled = false;
      const fail = (reason: RelayTunnelFailure, message: string) => {
        const error = new RelayTunnelClientError(reason, message);
        if (client) return client.#fail(error);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        reject(error);
      };
      const timer = setTimeout(
        () => fail("relay_unreachable", "The relay or the computer did not answer in time."),
        CONNECT_TIMEOUT_MS,
      );
      const sendFrame = (payload: Uint8Array) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(encodeRelayFrame(CHANNEL, payload));
      };

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "hello", token: options.deviceToken, role: "client" }));
      });
      socket.addEventListener("error", () =>
        fail("relay_unreachable", "Could not reach the relay."),
      );
      socket.addEventListener("close", () => fail("closed", "The relay connection closed."));
      socket.addEventListener("message", (event) => {
        if (client) client.#heard();
        if (typeof event.data === "string") {
          const message = parseRelayServerMessage(event.data);
          if (message?.type === "ready") {
            deviceId = message.deviceId;
            socket.send(
              JSON.stringify({
                type: "open",
                channel: CHANNEL,
                hostDeviceId: options.hostDeviceId,
              }),
            );
            handshake = new NoiseHandshake({
              initiator: true,
              staticKeyPair: options.clientKeyPair,
              prologue: relayPrologue(options.hostDeviceId, deviceId),
              randomBytes: options.randomBytes,
            });
            sendFrame(handshake.writeMessage());
          } else if (message?.type === "error") {
            fail(
              message.code === "unauthorized" ? "unauthorized" : "closed",
              `The relay refused this device (${message.code}).`,
            );
          } else if (message?.type === "close" && message.channel === CHANNEL) {
            const reason = message.reason;
            fail(
              reason === "host_offline" || reason === "limit" || reason === "rejected"
                ? reason
                : "closed",
              reason === "host_offline"
                ? "The computer is not connected to the relay."
                : reason === "rejected"
                  ? "The computer did not allow this device."
                  : reason === "limit"
                    ? "The relay limit for this account is reached."
                    : `The computer closed the connection (${reason ?? "closed"}).`,
            );
          }
          return;
        }
        const frame = decodeRelayFrame(new Uint8Array(event.data as ArrayBuffer));
        if (!frame || frame.channel !== CHANNEL) return;
        try {
          if (client) return client.#onPayload(frame.payload);
          if (!session) {
            if (!handshake) return;
            handshake.readMessage(frame.payload);
            const remote = handshake.remoteStaticKey!;
            // The QR code's key is the only computer this device talks to: a relay in the middle fails here.
            if (!bytesEqual(remote, fromBase64Url(options.hostKey))) {
              return fail(
                "handshake_failed",
                "The computer's key does not match the one it was paired with.",
              );
            }
            const hello = {
              name: options.name,
              ...(options.pairingSecret ? { pairingSecret: options.pairingSecret } : {}),
            };
            sendFrame(handshake.writeMessage(new TextEncoder().encode(JSON.stringify(hello))));
            session = handshake.session();
            return;
          }
          const message = decodeTunnelMessage(session.receive.decrypt(frame.payload));
          if (message?.type !== TunnelMessageType.status)
            return fail("handshake_failed", "Unexpected message before approval.");
          const status = readTunnelJson<TunnelStatus>(message);
          if (status?.state === "pending") {
            // Waiting for the user's approval can take longer than a connect.
            clearTimeout(timer);
            return options.onPending?.();
          }
          if (status?.state !== "ready")
            return fail("handshake_failed", "Unexpected status from the computer.");
          settled = true;
          clearTimeout(timer);
          client = new RelayTunnelClient({
            socket,
            send: session.send,
            receive: session.receive,
            pairingToken: status.pairingToken,
            remoteStaticKey: session.remoteStaticKey,
            localStaticKey: options.clientKeyPair.publicKey,
          });
          resolve(client);
        } catch {
          fail("handshake_failed", "The secure handshake with the computer failed.");
        }
      });
    });
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  onClose(listener: (error: RelayTunnelClientError) => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close() {
    this.#fail(new RelayTunnelClientError("closed", "The relay connection was closed."));
  }

  /** A `fetch` that sends the request to the computer; only the path and query of the URL matter. */
  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const fromRequest = typeof input !== "string" && !(input instanceof URL) ? input : null;
    const url = new URL(fromRequest ? fromRequest.url : String(input));
    const method = (init?.method ?? fromRequest?.method ?? "GET").toUpperCase();
    const headers: Array<[string, string]> = [];
    new Headers(init?.headers ?? fromRequest?.headers).forEach((value, name) =>
      headers.push([name, value]),
    );
    const body = await readRequestBody(init?.body, fromRequest, method);
    const signal = init?.signal ?? fromRequest?.signal ?? null;
    if (this.#closed) throw new TypeError(this.#closed.message);
    this.#probeIfQuiet();
    const stream = this.#allocateStream();
    const response = new Promise<Response>((resolve, reject) => {
      this.#http.set(stream, { resolve, reject, head: null, body: [] });
    });
    this.#sendTunnel(
      encodeTunnelJson(TunnelMessageType.open, stream, {
        kind: "http",
        method,
        path: url.pathname + url.search,
        headers,
      }),
    );
    for (let offset = 0; offset < body.length; offset += TUNNEL_CHUNK) {
      this.#sendTunnel(
        encodeTunnelMessage(
          TunnelMessageType.data,
          stream,
          body.subarray(offset, offset + TUNNEL_CHUNK),
        ),
      );
    }
    this.#sendTunnel(encodeTunnelMessage(TunnelMessageType.end, stream));
    const abort = () => {
      this.#sendTunnel(encodeTunnelJson(TunnelMessageType.reset, stream, { message: "aborted" }));
      const error = new Error("The request was aborted.");
      error.name = "AbortError";
      this.#finishHttp(stream, error);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    return response;
  };

  /** A `WebSocket` constructor bound to this tunnel; only the path and query of the URL matter. */
  createWebSocket(url: string | URL, protocols?: string | ReadonlyArray<string>): WebSocket {
    const stream = this.#allocateStream();
    const parsed = new URL(url);
    const socket = new RelayTunnelWebSocket(parsed.toString(), {
      send: (message) => this.#sendTunnel(message),
      stream,
      onDone: () => this.#sockets.delete(stream),
    });
    this.#sockets.set(stream, socket);
    const list =
      protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : [...protocols];
    if (this.#closed) queueMicrotask(() => socket.handleFailure());
    else {
      this.#probeIfQuiet();
      this.#sendTunnel(
        encodeTunnelJson(TunnelMessageType.open, stream, {
          kind: "ws",
          path: parsed.pathname + parsed.search,
          protocols: list,
        }),
      );
    }
    return socket as unknown as WebSocket;
  }

  #allocateStream() {
    const stream = this.#nextStream;
    this.#nextStream = this.#nextStream >= 0xffff_fff0 ? 1 : this.#nextStream + 1;
    return stream;
  }

  #sendTunnel(plaintext: Uint8Array) {
    if (this.#closed) return;
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return this.#fail(new RelayTunnelClientError("closed", "The relay connection is gone."));
    }
    this.#socket.send(encodeRelayFrame(CHANNEL, this.#send.encrypt(plaintext)));
  }

  #heard() {
    this.#lastInbound = Date.now();
    if (this.#probeTimer) clearTimeout(this.#probeTimer);
    this.#probeTimer = null;
  }

  #probeIfQuiet() {
    if (Date.now() - this.#lastInbound > QUIET_BEFORE_PROBE_MS) this.#probe();
  }

  /** Asks the relay for a pong; any message from it within the timeout counts. */
  #probe() {
    if (this.#closed || this.#probeTimer) return;
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return this.#fail(new RelayTunnelClientError("closed", "The relay connection is gone."));
    }
    this.#socket.send(JSON.stringify({ type: "ping" }));
    this.#probeTimer = setTimeout(
      () => this.#fail(new RelayTunnelClientError("closed", "The relay stopped answering.")),
      PROBE_TIMEOUT_MS,
    );
  }

  #onPayload(payload: Uint8Array) {
    let message: TunnelMessage | null;
    try {
      message = decodeTunnelMessage(this.#receive.decrypt(payload));
    } catch {
      return this.#fail(
        new RelayTunnelClientError(
          "handshake_failed",
          "A message from the computer failed authentication.",
        ),
      );
    }
    if (!message) return;
    const http = this.#http.get(message.stream);
    if (http) return this.#onHttpMessage(message, http);
    this.#sockets.get(message.stream)?.handleMessage(message);
  }

  #onHttpMessage(message: TunnelMessage, http: PendingHttp) {
    switch (message.type) {
      case TunnelMessageType.head:
        http.head = readTunnelJson<TunnelHead>(message);
        if (!http.head) this.#finishHttp(message.stream, new TypeError("Malformed response head."));
        return;
      case TunnelMessageType.data:
        http.body.push(message.body.slice());
        return;
      case TunnelMessageType.end:
        return this.#finishHttp(message.stream, null);
      case TunnelMessageType.reset:
        return this.#finishHttp(
          message.stream,
          new TypeError(
            readTunnelJson<{ message?: string }>(message)?.message ??
              "The request failed on the computer.",
          ),
        );
    }
  }

  #finishHttp(stream: number, error: Error | null) {
    const http = this.#http.get(stream);
    if (!http) return;
    this.#http.delete(stream);
    if (error || !http.head)
      return http.reject(error ?? new TypeError("The computer sent no response."));
    const { status, headers } = http.head;
    const body = status === 204 || status === 304 || status === 101 ? null : concat(http.body);
    http.resolve(
      new Response(body, { status, headers: headers.map(([name, value]) => [name, value]) }),
    );
  }

  #fail(error: RelayTunnelClientError) {
    if (this.#closed) return;
    this.#closed = error;
    clearInterval(this.#keepalive);
    if (this.#probeTimer) clearTimeout(this.#probeTimer);
    for (const stream of this.#http.keys()) this.#finishHttp(stream, new TypeError(error.message));
    for (const socket of this.#sockets.values()) socket.handleFailure();
    this.#sockets.clear();
    if (
      this.#socket.readyState === WebSocket.OPEN ||
      this.#socket.readyState === WebSocket.CONNECTING
    )
      this.#socket.close();
    for (const listener of this.#closeListeners) listener(error);
  }
}

interface TunnelSocketWiring {
  readonly send: (message: Uint8Array) => void;
  readonly stream: number;
  readonly onDone: () => void;
}

/** Enough of the browser `WebSocket` for Effect's socket and the app's other sockets. */
type SocketEvent = { readonly type: string } & Record<string, unknown>;
type SocketListener = (event: SocketEvent) => void;

/** The `addEventListener` and `on…` half of a browser WebSocket, without relying on EventTarget (Hermes). */
class SocketEvents {
  onopen: SocketListener | null = null;
  onmessage: SocketListener | null = null;
  onclose: SocketListener | null = null;
  onerror: SocketListener | null = null;
  readonly #listeners = new Map<string, Set<SocketListener>>();

  addEventListener(type: string, listener: SocketListener) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: SocketListener) {
    this.#listeners.get(type)?.delete(listener);
  }

  protected emit(event: SocketEvent) {
    for (const listener of this.#listeners.get(event.type) ?? []) listener(event);
    const handler = {
      open: this.onopen,
      message: this.onmessage,
      close: this.onclose,
      error: this.onerror,
    }[event.type];
    handler?.(event);
  }
}

class RelayTunnelWebSocket extends SocketEvents {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  binaryType: "blob" | "arraybuffer" = "blob";
  readonly #wiring: TunnelSocketWiring;
  readonly #fragments: Array<Uint8Array> = [];

  readonly url: string;

  constructor(url: string, wiring: TunnelSocketWiring) {
    super();
    this.url = url;
    this.#wiring = wiring;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (this.readyState === 0) throw new Error("WebSocket is still connecting.");
    if (this.readyState !== 1) return;
    if (typeof data === "string") {
      for (const fragment of tunnelFragments(
        TunnelMessageType.text,
        this.#wiring.stream,
        new TextEncoder().encode(data),
      ))
        this.#wiring.send(fragment);
      return;
    }
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    for (const fragment of tunnelFragments(TunnelMessageType.data, this.#wiring.stream, bytes))
      this.#wiring.send(fragment);
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.#wiring.send(
      encodeTunnelJson(TunnelMessageType.end, this.#wiring.stream, { code, reason }),
    );
    this.#finish(code, reason, true);
  }

  handleMessage(message: TunnelMessage) {
    switch (message.type) {
      case TunnelMessageType.head: {
        const head = readTunnelJson<TunnelHead>(message);
        if (head?.status !== 101) return this.handleFailure();
        this.protocol = head.headers.find(([name]) => name === "sec-websocket-protocol")?.[1] ?? "";
        this.readyState = 1;
        this.emit({ type: "open" });
        return;
      }
      case TunnelMessageType.data:
      case TunnelMessageType.text: {
        this.#fragments.push(message.body.slice());
        if ((message.flags & TUNNEL_FLAG_FIN) === 0) return;
        const whole = concat(this.#fragments.splice(0));
        const data =
          message.type === TunnelMessageType.text
            ? new TextDecoder().decode(whole)
            : this.binaryType === "arraybuffer"
              ? whole.buffer
              : new Blob([whole]);
        this.emit({ type: "message", data });
        return;
      }
      case TunnelMessageType.end: {
        const close = readTunnelJson<{ code?: number; reason?: string }>(message);
        this.#finish(close?.code ?? 1005, close?.reason ?? "", true);
        return;
      }
      case TunnelMessageType.reset:
        this.handleFailure();
    }
  }

  handleFailure() {
    if (this.readyState === 3) return;
    this.emit({ type: "error" });
    this.#finish(1006, "", false);
  }

  #finish(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#wiring.onDone();
    this.emit({ type: "close", code, reason, wasClean });
  }
}

function concat(parts: ReadonlyArray<Uint8Array>) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Clients reach a computer over the relay at this made-up origin; the pool intercepts it. */
const RELAY_VIRTUAL_HOST_SUFFIX = ".relay.gustaf.invalid";

export function relayVirtualBaseUrl(hostDeviceId: string): string {
  return `https://${hostDeviceId.toLowerCase()}${RELAY_VIRTUAL_HOST_SUFFIX}`;
}

export function relayHostFromUrl(url: string | URL): string | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!hostname.endsWith(RELAY_VIRTUAL_HOST_SUFFIX)) return null;
  const host = hostname.slice(0, -RELAY_VIRTUAL_HOST_SUFFIX.length);
  return /^[a-z0-9-]{1,128}$/.test(host) ? host : null;
}

/**
 * One tunnel per computer, opened on first use and again after it drops. `fetch` and
 * `createWebSocket` route virtual relay URLs through it; the platform supplies the keys.
 */
export class RelayTunnelPool {
  readonly #resolve: (hostDeviceId: string) => Promise<RelayTunnelClientOptions>;
  readonly #clients = new Map<string, Promise<RelayTunnelClient>>();

  constructor(resolve: (hostDeviceId: string) => Promise<RelayTunnelClientOptions>) {
    this.#resolve = resolve;
  }

  client(hostDeviceId: string): Promise<RelayTunnelClient> {
    const existing = this.#clients.get(hostDeviceId);
    if (existing) return existing;
    const connecting = this.#resolve(hostDeviceId)
      .then((options) => RelayTunnelClient.connect(options))
      .then((client) => {
        client.onClose(() => {
          if (this.#clients.get(hostDeviceId) === connecting) this.#clients.delete(hostDeviceId);
        });
        return client;
      });
    connecting.catch(() => {
      if (this.#clients.get(hostDeviceId) === connecting) this.#clients.delete(hostDeviceId);
    });
    this.#clients.set(hostDeviceId, connecting);
    return connecting;
  }

  /** Drops a computer's tunnel, e.g. after its route is removed. */
  forget(hostDeviceId: string) {
    const existing = this.#clients.get(hostDeviceId);
    this.#clients.delete(hostDeviceId);
    void existing?.then((client) => client.close()).catch(() => undefined);
  }

  /** Wraps a platform `fetch` so virtual relay URLs go through the tunnel. */
  wrapFetch(base: typeof fetch): typeof fetch {
    return (async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      const host = relayHostFromUrl(url);
      if (host === null) return base(input, init);
      return (await this.client(host)).fetch(input, init);
    }) as typeof fetch;
  }

  /** A WebSocket for a virtual relay URL; it connects once the tunnel is up. */
  createWebSocket(url: string, protocols?: string | ReadonlyArray<string>): WebSocket {
    const host = relayHostFromUrl(url);
    if (host === null) throw new TypeError("Not a relay URL.");
    return new LazyRelayWebSocket(url, this.client(host), protocols) as unknown as WebSocket;
  }
}

class LazyRelayWebSocket extends SocketEvents {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  protocol = "";
  extensions = "";
  bufferedAmount = 0;
  #binaryType: "blob" | "arraybuffer" = "blob";
  #inner: WebSocket | null = null;
  readonly url: string;

  constructor(
    url: string,
    client: Promise<RelayTunnelClient>,
    protocols?: string | ReadonlyArray<string>,
  ) {
    super();
    this.url = url;
    client.then(
      (tunnel) => {
        if (this.readyState !== 0) return;
        const inner = tunnel.createWebSocket(url, protocols);
        inner.binaryType = this.#binaryType;
        this.#inner = inner;
        inner.addEventListener("open", () => {
          this.readyState = 1;
          this.protocol = inner.protocol;
          this.emit({ type: "open" });
        });
        inner.addEventListener("message", (event) =>
          this.emit({ type: "message", data: event.data }),
        );
        inner.addEventListener("error", () => this.emit({ type: "error" }));
        inner.addEventListener("close", (event) => {
          this.readyState = 3;
          this.emit({
            type: "close",
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });
        });
      },
      () => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit({ type: "error" });
        this.emit({ type: "close", code: 1006, reason: "", wasClean: false });
      },
    );
  }

  get binaryType() {
    return this.#binaryType;
  }

  set binaryType(value: "blob" | "arraybuffer") {
    this.#binaryType = value;
    if (this.#inner) this.#inner.binaryType = value;
  }

  send(data: string | ArrayBufferLike | ArrayBufferView) {
    if (!this.#inner || this.readyState !== 1) throw new Error("WebSocket is not open.");
    this.#inner.send(data as string);
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    if (this.#inner) return this.#inner.close(code, reason);
    this.readyState = 3;
    this.emit({ type: "close", code, reason, wasClean: true });
  }
}

/**
 * The body as bytes without going through `Request`: React Native's fetch polyfill has no
 * `Request.body` and cannot always turn a text body into an ArrayBuffer.
 */
async function readRequestBody(
  body: RequestInit["body"] | undefined,
  request: Request | null,
  method: string,
): Promise<Uint8Array> {
  if (method === "GET" || method === "HEAD") return new Uint8Array(0);
  if (body === undefined || body === null) {
    return request ? new TextEncoder().encode(await request.text()) : new Uint8Array(0);
  }
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
  }
  throw new TypeError("This request body type cannot be sent through the relay.");
}
