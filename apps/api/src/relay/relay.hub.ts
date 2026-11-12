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
  heartbeatMs: number;
  /** A peer that lets this much pile up unsent is too slow to keep. */
  maxBufferedBytes: number;
  maxChannelsPerClient: number;
  maxChannelsPerHost: number;
  maxSocketsPerUser: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  helloTimeoutMs: 10_000,
  heartbeatMs: 30_000,
  maxBufferedBytes: 8 * 1024 * 1024,
  maxChannelsPerClient: 8,
  maxChannelsPerHost: 64,
  maxSocketsPerUser: 20,
};

export interface RelayDependencies {
  authenticate(token: string): Promise<RelayDevice | undefined>;
  /** Of these device ids, the ones whose credential still works (not revoked, owner not banned). */
  stillUsable(deviceIds: ReadonlyArray<string>): Promise<ReadonlySet<string>>;
  /** Whether this user may open another channel (monthly byte budget). */
  mayOpen(userId: string): boolean;
  countBytes(userId: string, bytes: number): void;
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

  constructor(
    private readonly deps: RelayDependencies,
    private readonly limits: RelayLimits = DEFAULT_RELAY_LIMITS,
  ) {
    this.heartbeat = setInterval(() => void this.sweep(), limits.heartbeatMs);
    this.heartbeat.unref();
  }

  /** Attach to the HTTP server's `upgrade` event. Returns false for other paths. */
  handleUpgrade(request: NodeHttp.IncomingMessage, socket: NodeStream.Duplex, head: Buffer) {
    const path = (request.url ?? "").split("?")[0];
    if (path !== RELAY_PATH) return false;
    this.server.handleUpgrade(request, socket, head, (ws) => this.accept(ws, request));
    return true;
  }

  onlineHosts(userId: string) {
    return [...this.hosts.values()]
      .filter((peer) => peer.device.userId === userId)
      .map((peer) => peer.device.id);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const peer of this.peers) peer.socket.terminate();
    this.server.close();
  }

  private accept(socket: WebSocket, request: NodeHttp.IncomingMessage) {
    const ip = request.socket.remoteAddress;
    const timer = setTimeout(() => socket.close(4401, "hello timeout"), this.limits.helloTimeoutMs);
    socket.once("message", async (data, isBinary) => {
      clearTimeout(timer);
      const hello = isBinary ? null : this.parse(data);
      const token =
        typeof hello?.token === "string" && TOKEN.test(hello.token) ? hello.token : null;
      const role = hello?.role === "host" || hello?.role === "client" ? hello.role : null;
      if (hello?.type !== "hello" || !token || !role) return this.fail(socket, "bad_hello");
      let device: RelayDevice | undefined;
      try {
        device = await this.deps.authenticate(token);
      } catch {
        return this.fail(socket, "unavailable", 1011);
      }
      if (!device) return this.fail(socket, "unauthorized", 4401);
      if (role === "host" && device.kind !== "computer")
        return this.fail(socket, "not_a_computer", 4403);
      if (socket.readyState !== WebSocket.OPEN) return;
      const sockets = [...this.peers].filter((peer) => peer.device.userId === device.userId).length;
      if (sockets >= this.limits.maxSocketsPerUser) return this.fail(socket, "limit", 4429);
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
    if (!message || !isChannel(message.channel)) return this.fail(peer.socket, "bad_message");
    const channel = message.channel;
    if (message.type === "close") {
      const link = peer.channels.get(channel);
      if (!link) return;
      peer.channels.delete(channel);
      this.dropLink(link, "peer_closed");
      return;
    }
    if (message.type !== "open" || peer.role !== "client")
      return this.fail(peer.socket, "bad_message");
    if (peer.channels.has(channel)) return this.fail(peer.socket, "bad_message");
    const host =
      typeof message.hostDeviceId === "string" ? this.hosts.get(message.hostDeviceId) : undefined;
    // Another user's computer looks exactly like an offline one.
    if (!host || host.device.userId !== peer.device.userId) {
      return this.send(peer, { type: "close", channel, reason: "host_offline" });
    }
    if (
      peer.channels.size >= this.limits.maxChannelsPerClient ||
      host.channels.size >= this.limits.maxChannelsPerHost ||
      !this.deps.mayOpen(peer.device.userId)
    ) {
      return this.send(peer, { type: "close", channel, reason: "limit" });
    }
    let hostChannel = 1 + Math.floor(Math.random() * 0xffff_fffe);
    while (host.channels.has(hostChannel)) hostChannel = (hostChannel % 0xffff_ffff) + 1;
    peer.channels.set(channel, { peer: host, peerChannel: hostChannel });
    host.channels.set(hostChannel, { peer, peerChannel: channel });
    this.send(host, { type: "open", channel: hostChannel, clientDeviceId: peer.device.id });
  }

  private forward(peer: Peer, data: RawData) {
    const frame = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (frame.length <= FRAME_HEADER) return;
    const channel = frame.readUInt32BE(0);
    const link = peer.channels.get(channel);
    if (!link) return this.send(peer, { type: "close", channel, reason: "not_found" });
    const target = link.peer;
    if (target.socket.bufferedAmount > this.limits.maxBufferedBytes) {
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
        if (!usable.has(peer.device.id)) peer.socket.close(4401, "revoked");
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

  private fail(socket: WebSocket, code: string, closeCode = 4400) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code }));
    socket.close(closeCode, code);
  }
}
