import type * as NodeHttp from "node:http";
import type * as NodeStream from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";

// Wire format: see packages/shared/src/relayTunnel.ts. The relay reads only the JSON control
// messages and the 4-byte channel prefix of binary frames; the rest is end-to-end encrypted.
export const RELAY_PATH = "/v1/relay";
const FRAME_HEADER = 4;
const MAX_FRAME = FRAME_HEADER + 65_535;
const MAX_CONTROL = 4 * 1024;

export interface RelayDevice {
  id: string;
  userId: string;
  kind: "computer" | "phone";
}

export interface RelayLimits {
  helloTimeoutMs: number;
  /** Connection attempts per client IP per minute, checked before any database work. */
  connectsPerMinutePerIp: number;
  heartbeatMs: number;
  /** A peer that lets this much pile up unsent is too slow to keep. */
  maxBufferedBytes: number;
  maxChannelsPerClient: number;
  maxChannelsPerHost: number;
  maxSocketsPerUser: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  helloTimeoutMs: 10_000,
  connectsPerMinutePerIp: 30,
  heartbeatMs: 30_000,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxChannelsPerClient: 8,
  maxChannelsPerHost: 64,
  maxSocketsPerUser: 20,
};

/**
 * Counted connection and channel outcomes. `attempt` and `connected` are sockets, `channel_opened`
 * is a tunnel; every other name is a refusal or a drop, by reason.
 */
export const RELAY_EVENTS = [
  "attempt",
  "connected",
  "channel_opened",
  "rate_limited",
  "hello_timeout",
  "bad_hello",
  "unauthorized",
  "unavailable",
  "not_a_computer",
  "socket_limit",
  "host_offline",
  "channel_limit",
  "budget_exceeded",
  "protocol_error",
  "too_slow",
  "revoked",
] as const;
export type RelayEvent = (typeof RELAY_EVENTS)[number];

export interface RelayDependencies {
  authenticate(token: string): Promise<RelayDevice | undefined>;
  /** Of these device ids, the ones whose credential still works (not revoked, owner not banned). */
  stillUsable(deviceIds: ReadonlyArray<string>): Promise<ReadonlySet<string>>;
  /** Whether this user may open another channel (monthly byte budget). */
  mayOpen(userId: string): boolean;
  countBytes(userId: string, bytes: number): void;
  record(event: RelayEvent): void;
  log(event: Record<string, unknown>): void;
}

interface Link {
  peer: Peer;
  peerChannel: number;
}

interface Peer {
  socket: WebSocket;
  device: RelayDevice;
  role: "host" | "client";
  channels: Map<number, Link>;
  alive: boolean;
  bytes: number;
  openedAt: number;
}

const TOKEN = /^gdt_[A-Za-z0-9_-]{43}$/;

function isChannel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}

/**
 * Pairs a client's channel with a channel on the host it asked for, if both belong to one user,
 * and copies frames between them. Presence lives in memory: one process, one relay.
 */
export class RelayHub {
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  private readonly hosts = new Map<string, Peer>();
  private readonly peers = new Set<Peer>();
  private readonly heartbeat: NodeJS.Timeout;
  private checkingRevocations = false;
  private attempts = new Map<string, number>();
  private attemptsWindowStart = Date.now();
  private readonly since = new Date();
  private readonly counts = new Map<RelayEvent, number>();

  constructor(
    private readonly deps: RelayDependencies,
    private readonly limits: RelayLimits = DEFAULT_RELAY_LIMITS,
    /** Express's `trust proxy` hop count: how many proxies in front of us add X-Forwarded-For. */
    private readonly trustedProxyHops = 0,
  ) {
    this.heartbeat = setInterval(() => void this.sweep(), limits.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Attach to the HTTP server's `upgrade` event. Returns false for other paths. */
  handleUpgrade(request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) {
    const path = (request.url ?? "").split("?")[0];
    if (path !== RELAY_PATH) return false;
    this.count("attempt");
    const ip = this.clientIp(request);
    if (!this.allowAttempt(ip)) {
      this.count("rate_limited");
      socket.end(
        "HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => this.accept(ws, ip));
    return true;
  }

  onlineHosts(userId: string) {
    return [...this.hosts.values()]
      .filter((peer) => peer.device.userId === userId)
      .map((peer) => peer.device.id);
  }

  /** Presence right now and outcome counts since this process started. */
  stats() {
    let openTunnels = 0;
    for (const peer of this.peers) if (peer.role === "client") openTunnels += peer.channels.size;
    return {
      hostsOnline: this.hosts.size,
      clientsOnline: this.peers.size - this.hosts.size,
      openTunnels,
      since: this.since,
      counts: Object.fromEntries(RELAY_EVENTS.map((event) => [event, this.counts.get(event) ?? 0])),
    };
  }

  close() {
    clearInterval(this.heartbeat);
    for (const peer of this.peers) peer.socket.terminate();
    this.server.close();
  }

  private accept(socket: WebSocket, ip: string | undefined) {
    const timer = setTimeout(() => {
      this.count("hello_timeout");
      socket.close(4401, "hello timeout");
    }, this.limits.helloTimeoutMs);
    socket.once("message", async (data, isBinary) => {
      clearTimeout(timer);
      const hello = isBinary ? null : this.parse(data);
      const token =
        typeof hello?.token === "string" && TOKEN.test(hello.token) ? hello.token : null;
      const role = hello?.role === "host" || hello?.role === "client" ? hello.role : null;
      if (hello?.type !== "hello" || !token || !role) {
        this.count("bad_hello");
        return this.fail(socket, "bad_hello");
      }
      let device: RelayDevice | undefined;
      try {
        device = await this.deps.authenticate(token);
      } catch {
        this.count("unavailable");
        return this.fail(socket, "unavailable", 1011);
      }
      if (!device) {
        this.count("unauthorized");
        return this.fail(socket, "unauthorized", 4401);
      }
      if (role === "host" && device.kind !== "computer") {
        this.count("not_a_computer");
        return this.fail(socket, "not_a_computer", 4403);
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      const sockets = [...this.peers].filter((peer) => peer.device.userId === device.userId).length;
      if (sockets >= this.limits.maxSocketsPerUser) {
        this.count("socket_limit");
        return this.fail(socket, "limit", 4429);
      }
      this.join(
        { socket, device, role, channels: new Map(), alive: true, bytes: 0, openedAt: Date.now() },
        ip,
      );
    });
    socket.on("error", () => socket.terminate());
  }

  private join(peer: Peer, ip: string | undefined) {
    if (peer.role === "host") {
      // A restarted server reconnects before the old socket times out.
      this.hosts.get(peer.device.id)?.socket.close(4409, "replaced");
      this.hosts.set(peer.device.id, peer);
    }
    this.peers.add(peer);
    this.count("connected");
    this.deps.log({
      event: "relay.connect",
      role: peer.role,
      deviceId: peer.device.id,
      userId: peer.device.userId,
      ip,
    });
    this.send(peer, { type: "ready", deviceId: peer.device.id });
    peer.socket.on("pong", () => {
      peer.alive = true;
    });
    peer.socket.on("message", (data, isBinary) => {
      peer.alive = true;
      if (isBinary) this.forward(peer, data);
      else this.control(peer, this.parse(data));
    });
    peer.socket.on("close", () => this.leave(peer));
  }

  private leave(peer: Peer) {
    if (!this.peers.delete(peer)) return;
    if (this.hosts.get(peer.device.id) === peer) this.hosts.delete(peer.device.id);
    for (const [, link] of peer.channels) this.dropLink(link, "peer_closed");
    peer.channels.clear();
    this.deps.log({
      event: "relay.disconnect",
      role: peer.role,
      deviceId: peer.device.id,
      userId: peer.device.userId,
      bytes: peer.bytes,
      seconds: Math.round((Date.now() - peer.openedAt) / 1000),
    });
  }

  private control(peer: Peer, message: Record<string, unknown> | null) {
    // Clients cannot send WebSocket pings from a browser-style API; this is how they detect a dead socket.
    if (message?.type === "ping") return this.send(peer, { type: "pong" });
    if (!message || !isChannel(message.channel)) return this.protocolError(peer);
    const channel = message.channel;
    if (message.type === "close") {
      const link = peer.channels.get(channel);
      if (!link) return;
      peer.channels.delete(channel);
      this.dropLink(link, "peer_closed");
      return;
    }
    if (message.type !== "open" || peer.role !== "client" || peer.channels.has(channel)) {
      return this.protocolError(peer);
    }
    const host =
      typeof message.hostDeviceId === "string" ? this.hosts.get(message.hostDeviceId) : undefined;
    // Another user's computer looks exactly like an offline one.
    if (!host || host.device.userId !== peer.device.userId) {
      this.count("host_offline");
      return this.send(peer, { type: "close", channel, reason: "host_offline" });
    }
    const refusal =
      peer.channels.size >= this.limits.maxChannelsPerClient ||
      host.channels.size >= this.limits.maxChannelsPerHost
        ? "channel_limit"
        : this.deps.mayOpen(peer.device.userId)
          ? null
          : "budget_exceeded";
    if (refusal) {
      this.count(refusal);
      return this.send(peer, { type: "close", channel, reason: "limit" });
    }
    let hostChannel = 1 + Math.floor(Math.random() * 0xffff_fffe);
    while (host.channels.has(hostChannel)) hostChannel = (hostChannel % 0xffff_ffff) + 1;
    peer.channels.set(channel, { peer: host, peerChannel: hostChannel });
    host.channels.set(hostChannel, { peer, peerChannel: channel });
    this.send(host, { type: "open", channel: hostChannel, clientDeviceId: peer.device.id });
    this.count("channel_opened");
  }

  private forward(peer: Peer, data: RawData) {
    const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (frame.length <= FRAME_HEADER) return;
    const channel = frame.readUInt32BE(0);
    const link = peer.channels.get(channel);
    if (!link) return this.send(peer, { type: "close", channel, reason: "not_found" });
    const target = link.peer;
    if (target.socket.bufferedAmount > this.limits.maxBufferedBytes) {
      this.count("too_slow");
      target.socket.close(4408, "too slow");
      return;
    }
    frame.writeUInt32BE(link.peerChannel, 0);
    target.socket.send(frame, { binary: true });
    peer.bytes += frame.length;
    this.deps.countBytes(peer.device.userId, frame.length);
  }

  private dropLink(link: Link, reason: string) {
    if (link.peer.channels.delete(link.peerChannel)) {
      this.send(link.peer, { type: "close", channel: link.peerChannel, reason });
    }
  }

  /** The client's address behind `trustedProxyHops` proxies, the way Express reads `req.ip`. */
  private clientIp(request: NodeHttp.IncomingMessage) {
    const remote = request.socket.remoteAddress;
    const header = request.headers["x-forwarded-for"];
    if (this.trustedProxyHops === 0 || typeof header !== "string") return remote;
    const chain = [
      ...header
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
      remote,
    ];
    return chain[Math.max(0, chain.length - 1 - this.trustedProxyHops)] ?? remote;
  }

  private allowAttempt(ip: string | undefined) {
    const now = Date.now();
    if (now - this.attemptsWindowStart >= 60_000) {
      this.attempts = new Map();
      this.attemptsWindowStart = now;
    }
    const key = ip ?? "unknown";
    const count = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, count);
    return count <= this.limits.connectsPerMinutePerIp;
  }

  private async sweep() {
    for (const peer of this.peers) {
      if (!peer.alive) {
        peer.socket.terminate();
        continue;
      }
      peer.alive = false;
      peer.socket.ping();
    }
    // Revoked devices and banned users lose their open sockets within one heartbeat.
    if (this.checkingRevocations || this.peers.size === 0) return;
    this.checkingRevocations = true;
    try {
      const usable = await this.deps.stillUsable([
        ...new Set([...this.peers].map((peer) => peer.device.id)),
      ]);
      for (const peer of this.peers) {
        if (usable.has(peer.device.id)) continue;
        this.count("revoked");
        peer.socket.close(4401, "revoked");
      }
    } catch {
      // The database is away; keep the sockets and check again next time.
    } finally {
      this.checkingRevocations = false;
    }
  }

  private parse(data: RawData): Record<string, unknown> | null {
    const text = data.toString();
    if (text.length > MAX_CONTROL) return null;
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private send(peer: Peer, message: Record<string, unknown>) {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(message));
  }

  private count(event: RelayEvent) {
    this.counts.set(event, (this.counts.get(event) ?? 0) + 1);
    this.deps.record(event);
  }

  private protocolError(peer: Peer) {
    this.count("protocol_error");
    this.fail(peer.socket, "bad_message");
  }

  private fail(socket: WebSocket, code: string, closeCode = 4400) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code }));
    socket.close(closeCode, code);
  }
}
