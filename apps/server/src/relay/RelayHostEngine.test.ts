// @effect-diagnostics nodeBuiltinImport:off -- A real relay, host and local server on loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { RelayTunnelClient, RelayTunnelClientError } from "@t3tools/shared/relayTunnelClient";
import { generateNoiseKeyPair } from "@t3tools/shared/relayNoise";
import { toBase64Url } from "@t3tools/shared/relayTunnel";
import { describe, expect, it } from "@effect/vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

import {
  type RelayAdmission,
  type RelayClientIdentity,
  RelayHostEngine,
} from "./RelayHostEngine.ts";

const random = (length: number) => new Uint8Array(NodeCrypto.randomBytes(length));
const HOST_TOKEN = `gdt_${"h".repeat(43)}`;
const PHONE_TOKEN = `gdt_${"p".repeat(43)}`;

async function listen(server: NodeHttp.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

/** The cloud relay reduced to one host and its clients, same wire format as apps/api. */
async function startRelay() {
  const server = NodeHttp.createServer();
  const wss = new WebSocketServer({ server });
  let host: WsSocket | null = null;
  const clients = new Map<number, { socket: WsSocket; channel: number }>();
  let next = 100;
  wss.on("connection", (socket) => {
    let role: string | null = null;
    socket.on("message", (data, isBinary) => {
      if (!isBinary) {
        const message = JSON.parse(data.toString());
        if (message.type === "hello") {
          role = message.role;
          const deviceId =
            message.token === HOST_TOKEN
              ? "laptop"
              : message.token === PHONE_TOKEN
                ? "pixel"
                : null;
          if (!deviceId) return socket.close(4401);
          if (role === "host") host = socket;
          socket.send(JSON.stringify({ type: "ready", deviceId }));
        } else if (message.type === "open") {
          if (!host)
            return socket.send(
              JSON.stringify({ type: "close", channel: message.channel, reason: "host_offline" }),
            );
          const hostChannel = next++;
          clients.set(hostChannel, { socket, channel: message.channel });
          host.send(
            JSON.stringify({ type: "open", channel: hostChannel, clientDeviceId: "pixel" }),
          );
        } else if (message.type === "close" && role === "host") {
          const client = clients.get(message.channel);
          client?.socket.send(
            JSON.stringify({ type: "close", channel: client.channel, reason: message.reason }),
          );
        }
        return;
      }
      const frame = Buffer.from(data as Buffer);
      const channel = frame.readUInt32BE(0);
      if (role === "host") {
        const client = clients.get(channel);
        if (!client) return;
        frame.writeUInt32BE(client.channel, 0);
        client.socket.send(frame);
      } else {
        const hostChannel = [...clients].find(
          ([, client]) => client.socket === socket && client.channel === channel,
        )?.[0];
        if (hostChannel === undefined || !host) return;
        frame.writeUInt32BE(hostChannel, 0);
        host.send(frame);
      }
    });
  });
  const url = await listen(server);
  return {
    url,
    [Symbol.asyncDispose]: async () => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close();
    },
  };
}

/** Stands in for the Gustaf server on localhost: an HTTP echo and a WebSocket echo. */
async function startLocalServer() {
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/api/big") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.alloc(300_000, 7));
        return;
      }
      response.writeHead(201, { "content-type": "application/json", "x-echo": "yes" });
      response.end(
        JSON.stringify({
          method: request.method,
          url: request.url,
          authorization: request.headers.authorization ?? null,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket, request) => {
    socket.on("message", (data, isBinary) =>
      socket.send(isBinary ? data : `echo:${data.toString()}:${request.url}`, { binary: isBinary }),
    );
  });
  const url = await listen(server);
  return {
    url,
    [Symbol.asyncDispose]: async () => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close();
    },
  };
}

function startHost(
  relayUrl: string,
  localOrigin: string,
  admit: (client: RelayClientIdentity) => Promise<RelayAdmission>,
) {
  const hostKeyPair = generateNoiseKeyPair(random);
  const online = Promise.withResolvers<void>();
  const engine = new RelayHostEngine({
    relayUrl,
    deviceToken: HOST_TOKEN,
    hostKeyPair,
    randomBytes: random,
    localOrigin,
    admit,
    onState: (state) => {
      if (state.status === "online") online.resolve();
    },
    log: () => {},
  });
  engine.start();
  return {
    engine,
    hostKey: toBase64Url(hostKeyPair.publicKey),
    online: online.promise,
    [Symbol.dispose]: () => engine.stop(),
  };
}

const connect = (
  relayUrl: string,
  hostKey: string,
  extra: Partial<Parameters<typeof RelayTunnelClient.connect>[0]> = {},
) =>
  RelayTunnelClient.connect({
    relayUrl,
    deviceToken: PHONE_TOKEN,
    hostDeviceId: "laptop",
    hostKey,
    clientKeyPair: generateNoiseKeyPair(random),
    name: "Pixel",
    randomBytes: random,
    ...extra,
  });

describe("relay tunnel", () => {
  it("pairs after approval, then carries HTTP and WebSocket traffic to the local server", async () => {
    await using relay = await startRelay();
    await using local = await startLocalServer();
    const admitted: Array<RelayClientIdentity> = [];
    const approve = Promise.withResolvers<RelayAdmission>();
    using host = startHost(relay.url, local.url, async (client) => {
      admitted.push(client);
      return { kind: "pending", decision: approve.promise };
    });
    await host.online;

    const pending = Promise.withResolvers<void>();
    const connecting = connect(relay.url, host.hostKey, {
      pairingSecret: "s".repeat(32),
      onPending: pending.resolve,
    });
    await pending.promise;
    expect(admitted).toMatchObject([
      { clientDeviceId: "pixel", hello: { name: "Pixel", pairingSecret: "s".repeat(32) } },
    ]);
    approve.resolve({ kind: "ready", bearerToken: "bearer-1" });
    const client = await connecting;
    expect(client.bearerToken).toBe("bearer-1");

    const response = await client.fetch("https://relay.invalid/api/echo?x=1", {
      method: "POST",
      headers: { authorization: "Bearer bearer-1", "content-type": "text/plain" },
      body: "hello",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-echo")).toBe("yes");
    expect(await response.json()).toEqual({
      method: "POST",
      url: "/api/echo?x=1",
      authorization: "Bearer bearer-1",
      body: "hello",
    });

    const big = await client.fetch("https://relay.invalid/api/big");
    expect((await big.arrayBuffer()).byteLength).toBe(300_000);

    const socket = client.createWebSocket("wss://relay.invalid/ws?ticket=t1");
    const messages: Array<unknown> = [];
    const opened = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    socket.addEventListener("open", () => opened.resolve());
    socket.addEventListener("message", (event) => {
      messages.push(event.data);
      if (messages.length === 2) received.resolve();
    });
    await opened.promise;
    socket.send("ping");
    socket.binaryType = "arraybuffer";
    socket.send(new Uint8Array(100_000).fill(3));
    await received.promise;
    expect(messages[0]).toBe("echo:ping:/ws?ticket=t1");
    expect((messages[1] as ArrayBuffer).byteLength).toBe(100_000);

    const closed = Promise.withResolvers<{ code: number }>();
    client.onClose(() => {});
    socket.addEventListener("close", (event) =>
      closed.resolve(event as unknown as { code: number }),
    );
    host.engine.disconnectClient(admitted[0]!.clientKey);
    expect((await closed.promise).code).toBe(1006);
  });

  it("refuses a computer whose key differs from the paired one, and a rejected device", async () => {
    await using relay = await startRelay();
    await using local = await startLocalServer();
    using host = startHost(relay.url, local.url, async () => ({
      kind: "reject",
      reason: "rejected",
    }));
    await host.online;

    const impostorKey = toBase64Url(generateNoiseKeyPair(random).publicKey);
    await expect(connect(relay.url, impostorKey)).rejects.toMatchObject({
      reason: "handshake_failed",
    });
    const rejected = await connect(relay.url, host.hostKey).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(RelayTunnelClientError);
    expect(rejected).toMatchObject({ reason: "rejected" });
  });
});
