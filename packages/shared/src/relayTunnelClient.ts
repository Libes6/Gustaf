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
  /** Set once, when the computer's user approved this device during pairing. */
  readonly bearerToken: string | undefined;
  readonly remoteStaticKey: Uint8Array;
  readonly localStaticKey: Uint8Array;

  private constructor(input: {
    socket: WebSocket;
    send: NoiseCipherState;
    receive: NoiseCipherState;
    bearerToken: string | undefined;
    remoteStaticKey: Uint8Array;
    localStaticKey: Uint8Array;
  }) {
    this.#socket = input.socket;
    this.#send = input.send;
    this.#receive = input.receive;
    this.bearerToken = input.bearerToken;
    this.remoteStaticKey = input.remoteStaticKey;
    this.localStaticKey = input.localStaticKey;
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
            bearerToken: status.bearerToken,
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
    const request = new Request(input, init);
    if (this.#closed) throw new TypeError(this.#closed.message);
    const url = new URL(request.url);
    const stream = this.#allocateStream();
    const headers: Array<[string, string]> = [];
    request.headers.forEach((value, name) => headers.push([name, value]));
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : new Uint8Array(0);
    const response = new Promise<Response>((resolve, reject) => {
      this.#http.set(stream, { resolve, reject, head: null, body: [] });
    });
    this.#sendTunnel(
      encodeTunnelJson(TunnelMessageType.open, stream, {
        kind: "http",
        method: request.method,
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
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
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
    else
      this.#sendTunnel(
        encodeTunnelJson(TunnelMessageType.open, stream, {
          kind: "ws",
          path: parsed.pathname + parsed.search,
          protocols: list,
        }),
      );
    return socket as unknown as WebSocket;
  }

  #allocateStream() {
    const stream = this.#nextStream;
    this.#nextStream = this.#nextStream >= 0xffff_fff0 ? 1 : this.#nextStream + 1;
    return stream;
  }

  #sendTunnel(plaintext: Uint8Array) {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(encodeRelayFrame(CHANNEL, this.#send.encrypt(plaintext)));
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

class RelayTunnelWebSocket {
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
  onopen: SocketListener | null = null;
  onmessage: SocketListener | null = null;
  onclose: SocketListener | null = null;
  onerror: SocketListener | null = null;
  readonly #listeners = new Map<string, Set<SocketListener>>();
  readonly #wiring: TunnelSocketWiring;
  readonly #fragments: Array<Uint8Array> = [];

  readonly url: string;

  constructor(url: string, wiring: TunnelSocketWiring) {
    this.url = url;
    this.#wiring = wiring;
  }

  addEventListener(type: string, listener: SocketListener) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: SocketListener) {
    this.#listeners.get(type)?.delete(listener);
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
        this.#emit({ type: "open" });
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
        this.#emit({ type: "message", data });
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
    this.#emit({ type: "error" });
    this.#finish(1006, "", false);
  }

  #finish(code: number, reason: string, wasClean: boolean) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#wiring.onDone();
    this.#emit({ type: "close", code, reason, wasClean });
  }

  #emit(event: SocketEvent) {
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

function concat(parts: ReadonlyArray<Uint8Array>) {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
