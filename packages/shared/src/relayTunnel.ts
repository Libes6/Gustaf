/**
 * Wire formats of the Gustaf relay shared by the host (apps/server) and clients. The cloud relay
 * (apps/api) only reads the control messages and the 4-byte channel prefix; everything after the
 * prefix is a Noise message it cannot read. See docs/internals/relay.md.
 */
import { NOISE_MAX_MESSAGE_LENGTH } from "./relayNoise.ts";

export const RELAY_SOCKET_PATH = "/v1/relay";
/**
 * Set by the host on every HTTP request it replays from the tunnel (a client's own value is
 * dropped), so the server can tell relay clients apart from ones on this machine or network.
 */
export const RELAY_TUNNEL_HEADER = "x-gustaf-relay";
export const RELAY_PROTOCOL_VERSION = 1;

export type RelayRole = "host" | "client";

export type RelayClientMessage =
  | { readonly type: "hello"; readonly token: string; readonly role: RelayRole }
  | { readonly type: "open"; readonly channel: number; readonly hostDeviceId: string }
  | { readonly type: "close"; readonly channel: number; readonly reason?: string }
  /** A browser-style WebSocket cannot ping, so liveness is a control message. */
  | { readonly type: "ping" };

export type RelayServerMessage =
  | { readonly type: "ready"; readonly deviceId: string }
  | { readonly type: "open"; readonly channel: number; readonly clientDeviceId: string }
  | { readonly type: "close"; readonly channel: number; readonly reason?: string }
  | { readonly type: "error"; readonly code: string; readonly message?: string }
  | { readonly type: "pong" };

/** Close reasons the relay sends for a channel it ends itself. */
export type RelayCloseReason = "host_offline" | "not_found" | "limit" | "peer_closed" | "replaced";

export function parseRelayServerMessage(text: string): RelayServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "pong":
      return { type: "pong" };
    case "ready":
      return typeof message.deviceId === "string"
        ? { type: "ready", deviceId: message.deviceId }
        : null;
    case "open":
      return isChannel(message.channel) && typeof message.clientDeviceId === "string"
        ? { type: "open", channel: message.channel, clientDeviceId: message.clientDeviceId }
        : null;
    case "close":
      return isChannel(message.channel)
        ? {
            type: "close",
            channel: message.channel,
            ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
          }
        : null;
    case "error":
      return typeof message.code === "string"
        ? {
            type: "error",
            code: message.code,
            ...(typeof message.message === "string" ? { message: message.message } : {}),
          }
        : null;
    default:
      return null;
  }
}

export function isChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

export const RELAY_FRAME_HEADER_LENGTH = 4;
export const RELAY_MAX_FRAME_LENGTH = RELAY_FRAME_HEADER_LENGTH + NOISE_MAX_MESSAGE_LENGTH;

export function encodeRelayFrame(channel: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(RELAY_FRAME_HEADER_LENGTH + payload.length);
  new DataView(frame.buffer).setUint32(0, channel);
  frame.set(payload, RELAY_FRAME_HEADER_LENGTH);
  return frame;
}

export function decodeRelayFrame(
  frame: Uint8Array,
): { readonly channel: number; readonly payload: Uint8Array } | null {
  if (frame.length < RELAY_FRAME_HEADER_LENGTH || frame.length > RELAY_MAX_FRAME_LENGTH)
    return null;
  const channel = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
  if (!isChannel(channel)) return null;
  return { channel, payload: frame.subarray(RELAY_FRAME_HEADER_LENGTH) };
}

/** Binds a handshake to the two device ids the relay vouched for. */
export function relayPrologue(hostDeviceId: string, clientDeviceId: string): Uint8Array {
  return new TextEncoder().encode(
    `gustaf-relay/${RELAY_PROTOCOL_VERSION}\n${hostDeviceId}\n${clientDeviceId}`,
  );
}

/** The client's third handshake message. A new device must carry the QR code's secret. */
export interface RelayClientHello {
  readonly name: string;
  readonly pairingSecret?: string;
}

export const TunnelMessageType = {
  /** Client opens a stream. Body: JSON `TunnelOpen`. */
  open: 1,
  /** Host answers a stream. Body: JSON `TunnelHead`. */
  head: 2,
  /** Body bytes: an HTTP body chunk, or a binary WebSocket message fragment. */
  data: 3,
  /** A text WebSocket message fragment (UTF-8). */
  text: 4,
  /** End of one direction. Body: empty for HTTP, JSON `{ code, reason }` for a WebSocket. */
  end: 5,
  /** Abort a stream. Body: JSON `{ message }`. */
  reset: 6,
  /** Stream 0, host to client. Body: JSON `TunnelStatus`. */
  status: 7,
} as const;
export type TunnelMessageType = (typeof TunnelMessageType)[keyof typeof TunnelMessageType];

/** On `data` and `text`: the last fragment of a WebSocket message. */
export const TUNNEL_FLAG_FIN = 1;
const TUNNEL_HEADER_LENGTH = 6;
const NOISE_TAG_LENGTH = 16;
/** The largest body one tunnel message can carry. */
export const TUNNEL_MAX_BODY = NOISE_MAX_MESSAGE_LENGTH - NOISE_TAG_LENGTH - TUNNEL_HEADER_LENGTH;
/** HTTP bodies and large WebSocket messages are cut into chunks of this size. */
export const TUNNEL_CHUNK = 60 * 1024;

export type TunnelOpen =
  | {
      readonly kind: "http";
      readonly method: string;
      /** Path and query, starting with `/`. */
      readonly path: string;
      readonly headers: ReadonlyArray<readonly [string, string]>;
    }
  | { readonly kind: "ws"; readonly path: string; readonly protocols: ReadonlyArray<string> };

export interface TunnelHead {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}

export type TunnelStatus =
  | { readonly state: "pending" }
  /**
   * `pairingToken` is sent once, right after the host's user approves a new device: a one-time
   * environment pairing code the client redeems through the tunnel like any other pairing link.
   */
  | { readonly state: "ready"; readonly pairingToken?: string };

export interface TunnelMessage {
  readonly type: TunnelMessageType;
  readonly flags: number;
  readonly stream: number;
  readonly body: Uint8Array;
}

export function encodeTunnelMessage(
  type: TunnelMessageType,
  stream: number,
  body: Uint8Array = new Uint8Array(0),
  flags = 0,
): Uint8Array {
  if (body.length > TUNNEL_MAX_BODY) throw new Error("Tunnel message body is too long.");
  const message = new Uint8Array(TUNNEL_HEADER_LENGTH + body.length);
  const view = new DataView(message.buffer);
  view.setUint8(0, type);
  view.setUint8(1, flags);
  view.setUint32(2, stream);
  message.set(body, TUNNEL_HEADER_LENGTH);
  return message;
}

export function encodeTunnelJson(
  type: TunnelMessageType,
  stream: number,
  value: unknown,
): Uint8Array {
  return encodeTunnelMessage(type, stream, new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeTunnelMessage(message: Uint8Array): TunnelMessage | null {
  if (message.length < TUNNEL_HEADER_LENGTH) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const type = view.getUint8(0);
  if (type < TunnelMessageType.open || type > TunnelMessageType.status) return null;
  return {
    type: type as TunnelMessageType,
    flags: view.getUint8(1),
    stream: view.getUint32(2),
    body: message.subarray(TUNNEL_HEADER_LENGTH),
  };
}

export function readTunnelJson<T>(message: TunnelMessage): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(message.body)) as T;
  } catch {
    return null;
  }
}

/** Cuts a WebSocket message into fragments; only the last carries `TUNNEL_FLAG_FIN`. */
export function* tunnelFragments(
  type: typeof TunnelMessageType.data | typeof TunnelMessageType.text,
  stream: number,
  payload: Uint8Array,
): Generator<Uint8Array> {
  if (payload.length === 0) {
    yield encodeTunnelMessage(type, stream, payload, TUNNEL_FLAG_FIN);
    return;
  }
  for (let offset = 0; offset < payload.length; offset += TUNNEL_CHUNK) {
    const end = Math.min(offset + TUNNEL_CHUNK, payload.length);
    yield encodeTunnelMessage(
      type,
      stream,
      payload.subarray(offset, end),
      end === payload.length ? TUNNEL_FLAG_FIN : 0,
    );
  }
}

export const RELAY_PAIRING_SCHEME = "gustaf:";
export const RELAY_PAIRING_PATH = "relay-pair";

export interface RelayPairingOffer {
  /** Origin of the cloud relay, e.g. https://api.libes6.ru. */
  readonly relayUrl: string;
  readonly hostDeviceId: string;
  /** The host's Noise static public key, base64url. */
  readonly hostKey: string;
  /** One-time secret, base64url; the host accepts it once, within minutes. */
  readonly secret: string;
  readonly hostName: string;
}

export function formatRelayPairingLink(offer: RelayPairingOffer): string {
  const query = new URLSearchParams({
    v: String(RELAY_PROTOCOL_VERSION),
    relay: offer.relayUrl,
    host: offer.hostDeviceId,
    key: offer.hostKey,
    secret: offer.secret,
    name: offer.hostName,
  });
  return `${RELAY_PAIRING_SCHEME}//${RELAY_PAIRING_PATH}?${query.toString()}`;
}

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

export function parseRelayPairingLink(link: string): RelayPairingOffer | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== RELAY_PAIRING_SCHEME || url.hostname !== RELAY_PAIRING_PATH) return null;
  const read = (name: string) => url.searchParams.get(name)?.trim() ?? "";
  if (read("v") !== String(RELAY_PROTOCOL_VERSION)) return null;
  let relayUrl: URL;
  try {
    relayUrl = new URL(read("relay"));
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(relayUrl.hostname);
  if (relayUrl.protocol !== "https:" && !(relayUrl.protocol === "http:" && loopback)) return null;
  const offer = {
    relayUrl: relayUrl.origin,
    hostDeviceId: read("host"),
    hostKey: read("key"),
    secret: read("secret"),
    hostName: read("name").slice(0, 100),
  };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(offer.hostDeviceId)) return null;
  if (!BASE64URL_32_BYTES.test(offer.hostKey)) return null;
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(offer.secret)) return null;
  return offer;
}

export function relaySocketUrl(relayUrl: string): string {
  const url = new URL(RELAY_SOCKET_PATH, relayUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
