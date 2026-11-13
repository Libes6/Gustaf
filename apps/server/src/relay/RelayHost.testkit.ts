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
export async function startLocalServer() {
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
          relay: request.headers["x-gustaf-relay"] ?? null,
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
