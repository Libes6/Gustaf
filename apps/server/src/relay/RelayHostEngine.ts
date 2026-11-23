// @effect-diagnostics globalTimers:off globalFetch:off globalRandom:off globalDate:off -- A plain socket engine outside the Effect runtime; RelayHost owns its lifecycle.
import {
  type NoiseCipherState,
  NoiseHandshake,
  type NoiseKeyPair,
  type RandomBytes,
} from "@t3tools/shared/relayNoise";
import {
  type RelayClientHello,
  type TunnelMessage,
  type TunnelOpen,
  RELAY_TUNNEL_HEADER,
  TUNNEL_CHUNK,
  TUNNEL_FLAG_FIN,
  TunnelMessageType,
  decodeRelayFrame,
  decodeTunnelMessage,
  encodeRelayFrame,
  encodeTunnelJson,
  encodeTunnelMessage,
  parseRelayServerMessage,
  readTunnelJson,
  relayPrologue,
  relaySocketUrl,
  toBase64Url,
  tunnelFragments,
} from "@t3tools/shared/relayTunnel";

/** What the host decides about a client whose handshake finished. */
export type RelayAdmission =
  | { readonly kind: "ready"; readonly pairingToken?: string }
  | { readonly kind: "reject"; readonly reason: string }
  /** Ask the user; the promise settles with their answer. */
  | { readonly kind: "pending"; readonly decision: Promise<RelayAdmission> };

export interface RelayClientIdentity {
  readonly clientDeviceId: string;
  /** The client's Noise static key, base64url. */
  readonly clientKey: string;
  readonly hello: RelayClientHello;
}

export interface RelayHostEngineOptions {
  readonly relayUrl: string;
  readonly deviceToken: string;
  readonly hostKeyPair: NoiseKeyPair;
  readonly randomBytes: RandomBytes;
  /** `http://127.0.0.1:<port>`: where tunneled requests go. */
  readonly localOrigin: string;
  readonly admit: (client: RelayClientIdentity) => Promise<RelayAdmission>;
  readonly onState: (state: RelayHostConnectionState) => void;
  readonly log: (message: string, detail?: Record<string, unknown>) => void;
}

export type RelayHostConnectionState =
  | { readonly status: "connecting" }
  | { readonly status: "online"; readonly deviceId: string }
  | { readonly status: "offline"; readonly error: string; readonly retryInMs: number }
  /** The relay refused this computer's credential; reconnecting will not help. */
  | { readonly status: "unauthorized"; readonly error: string };

const MAX_BACKOFF_MS = 5 * 60_000;
// Retrying at once would knock the newer connection off and loop; it may be this server's successor.
const REPLACED_RETRY_MS = 2 * 60_000;
// A sleeping laptop's socket dies without a close event, so the host pings the relay itself.
const KEEPALIVE_MS = 25_000;
const SILENCE_LIMIT_MS = 60_000;
const MAX_REQUEST_BODY = 64 * 1024 * 1024;
// Hop-by-hop headers and ones fetch computes itself.
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "proxy-authorization",
  "te",
  RELAY_TUNNEL_HEADER,
]);
// fetch already decoded the body, so the encoding and length no longer describe it.
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

interface HttpStream {
  readonly kind: "http";
  readonly open: Extract<TunnelOpen, { kind: "http" }>;
  readonly body: Array<Uint8Array>;
  bodyLength: number;
  readonly abort: AbortController;
}

interface WsStream {
  readonly kind: "ws";
  readonly socket: WebSocket;
  readonly pending: Array<string | Uint8Array>;
  readonly fragments: Array<Uint8Array>;
  fragmentText: boolean;
}

interface Channel {
  readonly id: number;
  readonly clientDeviceId: string;
  handshake: NoiseHandshake | null;
  send: NoiseCipherState | null;
  receive: NoiseCipherState | null;
  ready: boolean;
  closed: boolean;
  readonly streams: Map<number, HttpStream | WsStream>;
}

/**
 * One computer's side of the relay: an outbound socket, a Noise responder per client channel, and
 * a replay of each tunneled HTTP request and WebSocket against the local server.
 */
export class RelayHostEngine {
  readonly #options: RelayHostEngineOptions;
  #socket: WebSocket | null = null;
  #channels = new Map<number, Channel>();
  #stopped = false;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #deviceId = "";
  readonly #clientKeys = new Map<number, string>();

  constructor(options: RelayHostEngineOptions) {
    this.#options = options;
  }

  start() {
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#socket?.close(1000, "stopped");
    this.#dropChannels();
  }

  /** Ends the open channels of one client key, e.g. after the user revokes it. */
  disconnectClient(clientKey: string) {
    for (const channel of this.#channels.values()) {
      if (this.#clientKeys.get(channel.id) === clientKey) {
        this.#closeChannel(channel, "revoked");
      }
    }
  }

  #connect() {
    if (this.#stopped) return;
    this.#options.onState({ status: "connecting" });
    const socket = new WebSocket(relaySocketUrl(this.#options.relayUrl));
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    let failure = "The relay closed the connection.";
    let unauthorized = false;
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ type: "hello", token: this.#options.deviceToken, role: "host" }),
      );
    });
    let lastInbound = Date.now();
    const keepalive = setInterval(() => {
      if (this.#socket !== socket || this.#stopped) return clearInterval(keepalive);
      if (Date.now() - lastInbound > SILENCE_LIMIT_MS) {
        failure = "The relay stopped answering.";
        return gone(1006);
      }
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, KEEPALIVE_MS);
    // Also called for a socket that never reports its own close.
    const gone = (code: number) => {
      if (this.#socket !== socket) return;
      clearInterval(keepalive);
      this.#socket = null;
      this.#dropChannels();
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      if (this.#stopped) return;
      if (unauthorized || code === 4401 || code === 4403) {
        this.#options.onState({ status: "unauthorized", error: failure });
        return;
      }
      const replaced = code === 4409;
      if (replaced) failure = "Another Gustaf on this computer took over the relay.";
      const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.#attempt);
      const retryInMs = replaced
        ? REPLACED_RETRY_MS
        : Math.round(base / 2 + Math.random() * (base / 2));
      this.#attempt += 1;
      this.#options.onState({ status: "offline", error: failure, retryInMs });
      this.#retryTimer = setTimeout(() => this.#connect(), retryInMs);
    };
    socket.addEventListener("message", (event) => {
      lastInbound = Date.now();
      if (typeof event.data === "string") {
        const message = parseRelayServerMessage(event.data);
        if (!message) return;
        switch (message.type) {
          case "pong":
            return;
          case "ready":
            this.#attempt = 0;
            this.#deviceId = message.deviceId;
            this.#options.onState({ status: "online", deviceId: message.deviceId });
            return;
          case "open":
            this.#channels.set(message.channel, {
              id: message.channel,
              clientDeviceId: message.clientDeviceId,
              handshake: null,
              send: null,
              receive: null,
              ready: false,
              closed: false,
              streams: new Map(),
            });
            return;
          case "close": {
            const channel = this.#channels.get(message.channel);
            if (channel) this.#closeChannel(channel, null);
            return;
          }
          case "error":
            failure = `The relay refused the connection (${message.code}).`;
            unauthorized = ["unauthorized", "not_a_computer"].includes(message.code);
            return;
        }
      }
      const frame = decodeRelayFrame(new Uint8Array(event.data as ArrayBuffer));
      if (!frame) return;
      const channel = this.#channels.get(frame.channel);
      if (!channel || channel.closed) return;
      void this.#onFrame(channel, frame.payload).catch((error: unknown) => {
        this.#options.log("relay channel failed", { error: String(error) });
        this.#closeChannel(channel, "protocol_error");
      });
    });
    socket.addEventListener("close", (event) => gone(event.code));
    socket.addEventListener("error", () => {
      failure = "Could not reach the relay.";
    });
  }

  async #onFrame(channel: Channel, payload: Uint8Array) {
    if (!channel.receive) {
      if (!channel.handshake) {
        const handshake = new NoiseHandshake({
          initiator: false,
          staticKeyPair: this.#options.hostKeyPair,
          prologue: relayPrologue(this.#deviceId, channel.clientDeviceId),
          randomBytes: this.#options.randomBytes,
        });
        channel.handshake = handshake;
        handshake.readMessage(payload);
        this.#sendRaw(channel, handshake.writeMessage());
        return;
      }
      const handshake = channel.handshake;
      const hello = parseHello(handshake.readMessage(payload));
      if (!hello) throw new Error("Malformed client hello.");
      const session = handshake.session();
      channel.handshake = null;
      channel.send = session.send;
      channel.receive = session.receive;
      const clientKey = toBase64Url(session.remoteStaticKey);
      this.#clientKeys.set(channel.id, clientKey);
      await this.#admit(
        channel,
        await this.#options.admit({ clientDeviceId: channel.clientDeviceId, clientKey, hello }),
      );
      return;
    }
    const message = decodeTunnelMessage(channel.receive.decrypt(payload));
    if (!message) throw new Error("Malformed tunnel message.");
    // Nothing reaches the local server before the user has allowed this device.
    if (!channel.ready) throw new Error("Tunnel message before approval.");
    this.#onTunnelMessage(channel, message);
  }

  async #admit(channel: Channel, admission: RelayAdmission): Promise<void> {
    if (channel.closed) return;
    switch (admission.kind) {
      case "reject":
        this.#closeChannel(channel, admission.reason);
        return;
      case "pending":
        this.#sendTunnel(
          channel,
          encodeTunnelJson(TunnelMessageType.status, 0, { state: "pending" }),
        );
        return this.#admit(channel, await admission.decision);
      case "ready":
        channel.ready = true;
        this.#sendTunnel(
          channel,
          encodeTunnelJson(TunnelMessageType.status, 0, {
            state: "ready",
            ...(admission.pairingToken ? { pairingToken: admission.pairingToken } : {}),
          }),
        );
    }
  }

  #onTunnelMessage(channel: Channel, message: TunnelMessage) {
    const stream = channel.streams.get(message.stream);
    switch (message.type) {
      case TunnelMessageType.open: {
        const open = readTunnelJson<TunnelOpen>(message);
        if (stream || !open || message.stream === 0 || !isLocalPath(open.path)) {
          this.#sendTunnel(
            channel,
            encodeTunnelJson(TunnelMessageType.reset, message.stream, { message: "bad open" }),
          );
          return;
        }
        if (open.kind === "http") {
          channel.streams.set(message.stream, {
            kind: "http",
            open,
            body: [],
            bodyLength: 0,
            abort: new AbortController(),
          });
        } else {
          this.#openWebSocket(channel, message.stream, open);
        }
        return;
      }
      case TunnelMessageType.data:
      case TunnelMessageType.text: {
        if (stream?.kind === "http") {
          stream.bodyLength += message.body.length;
          if (stream.bodyLength > MAX_REQUEST_BODY)
            return this.#resetStream(channel, message.stream, "body too large");
          stream.body.push(message.body.slice());
        } else if (stream?.kind === "ws") {
          stream.fragments.push(message.body.slice());
          stream.fragmentText = message.type === TunnelMessageType.text;
          if ((message.flags & TUNNEL_FLAG_FIN) === 0) return;
          const whole = concat(stream.fragments);
          stream.fragments.length = 0;
          const payload = stream.fragmentText ? new TextDecoder().decode(whole) : whole;
          if (stream.socket.readyState === WebSocket.OPEN) stream.socket.send(payload);
          else if (stream.socket.readyState === WebSocket.CONNECTING) stream.pending.push(payload);
        }
        return;
      }
      case TunnelMessageType.end: {
        if (stream?.kind === "http") void this.#runHttp(channel, message.stream, stream);
        else if (stream?.kind === "ws") {
          const close = readTunnelJson<{ code?: number; reason?: string }>(message);
          stream.socket.close(validCloseCode(close?.code), (close?.reason ?? "").slice(0, 120));
          channel.streams.delete(message.stream);
        }
        return;
      }
      case TunnelMessageType.reset: {
        if (stream?.kind === "http") stream.abort.abort();
        else if (stream?.kind === "ws") stream.socket.close();
        channel.streams.delete(message.stream);
        return;
      }
    }
  }

  async #runHttp(channel: Channel, id: number, stream: HttpStream) {
    const { open } = stream;
    const headers = new Headers();
    for (const [name, value] of open.headers) {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.append(name, value);
    }
    headers.set(RELAY_TUNNEL_HEADER, "1");
    try {
      const response = await fetch(new URL(open.path, this.#options.localOrigin), {
        method: open.method,
        headers,
        ...(open.method === "GET" || open.method === "HEAD" ? {} : { body: concat(stream.body) }),
        redirect: "manual",
        signal: stream.abort.signal,
      });
      const responseHeaders: Array<[string, string]> = [];
      response.headers.forEach((value, name) => {
        if (!DROPPED_RESPONSE_HEADERS.has(name)) responseHeaders.push([name, value]);
      });
      this.#sendTunnel(
        channel,
        encodeTunnelJson(TunnelMessageType.head, id, {
          status: response.status,
          headers: responseHeaders,
        }),
      );
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (let offset = 0; offset < value.length; offset += TUNNEL_CHUNK) {
            if (channel.closed) return void reader.cancel();
            await this.#sendTunnelAndDrain(
              channel,
              encodeTunnelMessage(
                TunnelMessageType.data,
                id,
                value.subarray(offset, offset + TUNNEL_CHUNK),
              ),
            );
          }
        }
      }
      this.#sendTunnel(channel, encodeTunnelMessage(TunnelMessageType.end, id));
    } catch (error) {
      if (!channel.closed) this.#resetStream(channel, id, String(error));
    } finally {
      channel.streams.delete(id);
    }
  }

  #openWebSocket(channel: Channel, id: number, open: Extract<TunnelOpen, { kind: "ws" }>) {
    const url = new URL(open.path, this.#options.localOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, [...open.protocols]);
    } catch (error) {
      this.#resetStream(channel, id, String(error));
      return;
    }
    socket.binaryType = "arraybuffer";
    const stream: WsStream = {
      kind: "ws",
      socket,
      pending: [],
      fragments: [],
      fragmentText: false,
    };
    channel.streams.set(id, stream);
    socket.addEventListener("open", () => {
      this.#sendTunnel(
        channel,
        encodeTunnelJson(TunnelMessageType.head, id, {
          status: 101,
          headers: socket.protocol ? [["sec-websocket-protocol", socket.protocol]] : [],
        }),
      );
      for (const pending of stream.pending.splice(0)) socket.send(pending);
    });
    socket.addEventListener("message", (event) => {
      if (channel.closed) return;
      const text = typeof event.data === "string";
      const payload = text
        ? new TextEncoder().encode(event.data as string)
        : new Uint8Array(event.data as ArrayBuffer);
      for (const fragment of tunnelFragments(
        text ? TunnelMessageType.text : TunnelMessageType.data,
        id,
        payload,
      )) {
        this.#sendTunnel(channel, fragment);
      }
    });
    socket.addEventListener("close", (event) => {
      if (!channel.streams.delete(id) || channel.closed) return;
      this.#sendTunnel(
        channel,
        encodeTunnelJson(TunnelMessageType.end, id, { code: event.code, reason: event.reason }),
      );
    });
    socket.addEventListener("error", () => {
      if (socket.readyState === WebSocket.CONNECTING)
        this.#resetStream(channel, id, "local socket failed");
    });
  }

  #resetStream(channel: Channel, id: number, message: string) {
    const stream = channel.streams.get(id);
    channel.streams.delete(id);
    if (stream?.kind === "ws") stream.socket.close();
    if (stream?.kind === "http") stream.abort.abort();
    this.#sendTunnel(channel, encodeTunnelJson(TunnelMessageType.reset, id, { message }));
  }

  #sendTunnel(channel: Channel, plaintext: Uint8Array) {
    if (channel.closed || !channel.send) return;
    this.#sendRaw(channel, channel.send.encrypt(plaintext));
  }

  /** Waits until the relay socket's buffer drains, so a large body cannot pile up in memory. */
  async #sendTunnelAndDrain(channel: Channel, plaintext: Uint8Array) {
    this.#sendTunnel(channel, plaintext);
    while (this.#socket && this.#socket.bufferedAmount > 1024 * 1024 && !channel.closed) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  #sendRaw(channel: Channel, payload: Uint8Array) {
    if (this.#socket?.readyState === WebSocket.OPEN)
      this.#socket.send(encodeRelayFrame(channel.id, payload));
  }

  #closeChannel(channel: Channel, reason: string | null) {
    if (channel.closed) return;
    channel.closed = true;
    this.#channels.delete(channel.id);
    this.#clientKeys.delete(channel.id);
    for (const stream of channel.streams.values()) {
      if (stream.kind === "ws") stream.socket.close();
      else stream.abort.abort();
    }
    channel.streams.clear();
    if (reason !== null && this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify({ type: "close", channel: channel.id, reason }));
    }
  }

  #dropChannels() {
    for (const channel of this.#channels.values()) this.#closeChannel(channel, null);
  }
}

function parseHello(payload: Uint8Array): RelayClientHello | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    const name = typeof value.name === "string" ? value.name.trim().slice(0, 100) : "";
    if (!name) return null;
    return {
      name,
      ...(typeof value.pairingSecret === "string" ? { pairingSecret: value.pairingSecret } : {}),
    };
  } catch {
    return null;
  }
}

function isLocalPath(path: string) {
  return path.startsWith("/") && !path.startsWith("//");
}

function validCloseCode(code: number | undefined) {
  return code === 1000 || (code !== undefined && code >= 3000 && code <= 4999) ? code : 1000;
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
