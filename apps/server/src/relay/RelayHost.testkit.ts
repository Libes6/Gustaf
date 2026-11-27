// @effect-diagnostics nodeBuiltinImport:off -- A relay and a local server on loopback sockets.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { WebSocketServer, type WebSocket as WsSocket } from "ws";

export const random = (length: number) => new Uint8Array(NodeCrypto.randomBytes(length));
export const HOST_TOKEN = `gdt_${"h".repeat(43)}`;
export const PHONE_TOKEN = `gdt_${"p".repeat(43)}`;

async function listen(server: NodeHttp.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  return `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
}

/** The cloud relay reduced to one host and its clients, same wire format as apps/api. */
export async function startRelay() {
  const server = NodeHttp.createServer((request, response) => {
    // `GET /v1/relay/hosts` as the API answers a device: the account's computers and who is online.
    if (request.url === "/v1/relay/hosts") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          online: host ? ["laptop"] : [],
          computers: [
            { id: "laptop", name: "Box", online: host !== null },
            { id: "pixel", name: "Mac", online: false },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ server });
  let host: WsSocket | null = null;
  // Settles each time a host says hello, so a test waits for the host instead of guessing.
  let hostHello = Promise.withResolvers<void>();
  /** `limit`: every new channel is refused as the relay does over a limit. */
  let refuse: "limit" | null = null;
  const clients = new Map<number, { socket: WsSocket; channel: number }>();
  let next = 100;
  wss.on("connection", (socket) => {
    let role: string | null = null;
    socket.on("close", () => {
      // As the real relay does: a client that goes away ends its channels on the host.
      if (role !== "client") return;
      for (const [hostChannel, client] of clients) {
        if (client.socket !== socket) continue;
        clients.delete(hostChannel);
        host?.send(JSON.stringify({ type: "close", channel: hostChannel, reason: "peer_closed" }));
      }
    });
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
          if (role === "host") {
            host = socket;
            socket.on("close", () => {
              if (host === socket) host = null;
              // As the real relay does: a host that goes away ends its clients' channels.
              for (const [hostChannel, client] of clients) {
                clients.delete(hostChannel);
                client.socket.send(
                  JSON.stringify({ type: "close", channel: client.channel, reason: "peer_closed" }),
                );
              }
            });
          }
          socket.send(JSON.stringify({ type: "ready", deviceId }));
          if (role === "host") hostHello.resolve();
        } else if (message.type === "open") {
          if (refuse !== null)
            return socket.send(
              JSON.stringify({ type: "close", channel: message.channel, reason: refuse }),
            );
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
    /** Resolves once a host is connected, now or when it next says hello. */
    nextHost: () => (host !== null ? Promise.resolve() : hostHello.promise),
    /** Cuts every socket at once, as a relay restart or a network change does. */
    dropEveryone: () => {
      host = null;
      hostHello = Promise.withResolvers<void>();
      for (const socket of wss.clients) socket.terminate();
    },
    refuseChannels: (reason: "limit" | null) => {
      refuse = reason;
    },
    [Symbol.asyncDispose]: async () => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.close();
    },
  };
}

/** Stands in for the Gustaf server on localhost: an HTTP echo and a WebSocket echo. */
export async function startLocalServer() {
  // `/api/stream` sends one event, then waits for the test before the second and the end.
  const release = Promise.withResolvers<void>();
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/api/stream") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        void release.promise.then(() => response.end("data: second\n\n"));
        return;
      }
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
          relay: request.headers["x-gustaf-relay"] ?? null,
          forwardedHost: request.headers["x-forwarded-host"] ?? null,
          forwardedProto: request.headers["x-forwarded-proto"] ?? null,
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
    releaseStream: () => release.resolve(),
    [Symbol.asyncDispose]: async () => {
      release.resolve();
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      server.closeAllConnections();
      server.close();
    },
  };
}
