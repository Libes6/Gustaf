// @effect-diagnostics nodeBuiltinImport:off -- Node HTTP server + ws for loopback relay DPoP integration test.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import {
  RelayTunnelClient,
  RelayTunnelClientError,
  RelayTunnelPool,
  relayVirtualBaseUrl,
} from "@t3tools/shared/relayTunnelClient";
import { generateNoiseKeyPair } from "@t3tools/shared/relayNoise";
import { toBase64Url } from "@t3tools/shared/relayTunnel";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpHeaders from "effect/http/Headers";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { WebSocketServer } from "ws";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { makeDpopKey } from "../auth/dpop.testkit.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  type RelayAdmission,
  type RelayClientIdentity,
  RelayHostEngine,
} from "./RelayHostEngine.ts";
import {
  HOST_TOKEN,
  PHONE_TOKEN,
  random,
  startLocalServer,
  startRelay,
} from "./RelayHost.testkit.ts";

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
  hostKey: string | null,
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
      onPending: () => pending.resolve(),
    });
    await pending.promise;
    expect(admitted).toMatchObject([
      { clientDeviceId: "pixel", hello: { name: "Pixel", pairingSecret: "s".repeat(32) } },
    ]);
    approve.resolve({ kind: "ready", pairingToken: "PAIRCODE1" });
    const client = await connecting;
    expect(client.pairingToken).toBe("PAIRCODE1");

    const response = await client.fetch("https://relay.invalid/api/echo?x=1", {
      method: "POST",
      // A client cannot pass itself off as local or spoof forwarded headers.
      headers: {
        authorization: "Bearer bearer-1",
        "content-type": "text/plain",
        "x-gustaf-relay": "0",
        "x-forwarded-host": "evil.invalid",
        "x-forwarded-proto": "http",
      },
      body: "hello",
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("x-echo")).toBe("yes");
    expect(await response.json()).toEqual({
      method: "POST",
      url: "/api/echo?x=1",
      authorization: "Bearer bearer-1",
      relay: "1",
      forwardedHost: "laptop.relay.gustaf.invalid",
      forwardedProto: "https",
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

  it("routes virtual relay URLs through one lazily opened tunnel per computer", async () => {
    await using relay = await startRelay();
    await using local = await startLocalServer();
    using host = startHost(relay.url, local.url, async () => ({ kind: "ready" }));
    await host.online;
    const clientKeyPair = generateNoiseKeyPair(random);
    let opened = 0;
    const pool = new RelayTunnelPool(async (hostDeviceId) => {
      opened += 1;
      return {
        relayUrl: relay.url,
        deviceToken: PHONE_TOKEN,
        hostDeviceId,
        hostKey: host.hostKey,
        clientKeyPair,
        name: "Pixel",
        randomBytes: random,
      };
    });
    const base = relayVirtualBaseUrl("laptop");
    const poolFetch = pool.wrapFetch(() => Promise.reject(new Error("not a relay URL")));
    const first = await poolFetch(`${base}/api/echo`, { method: "POST", body: "a" });
    expect(await first.json()).toMatchObject({ url: "/api/echo", body: "a" });

    const socket = pool.createWebSocket(`${base.replace("https", "wss")}/ws`);
    const reply = Promise.withResolvers<unknown>();
    socket.addEventListener("open", () => socket.send("hi"));
    socket.addEventListener("message", (event) => reply.resolve(event.data));
    expect(await reply.promise).toBe("echo:hi:/ws");
    expect(opened).toBe(1);
    await expect(poolFetch("https://example.invalid/")).rejects.toThrow("not a relay URL");
  });

  it("hands a response over once its headers arrive when the client streams, and ends it with the request", async () => {
    await using relay = await startRelay();
    await using local = await startLocalServer();
    using host = startHost(relay.url, local.url, async () => ({ kind: "ready" }));
    await host.online;
    const client = await connect(relay.url, host.hostKey, { streamResponses: true });

    // The response is in hand while the server is still writing it: only a stream can do that.
    const response = await client.fetch("https://relay.invalid/api/stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toBe("data: first\n\n");
    local.releaseStream();
    expect(decoder.decode((await reader.read()).value)).toBe("data: second\n\n");
    expect((await reader.read()).done).toBe(true);

    // Giving the stream up tells the computer to stop sending, and the tunnel stays usable.
    const again = await client.fetch("https://relay.invalid/api/stream");
    await again.body!.cancel();
    expect((await client.fetch("https://relay.invalid/api/echo")).status).toBe(201);
    client.close();
  });

  it("tells the host when a client that waits for approval gives up", async () => {
    await using relay = await startRelay();
    await using local = await startLocalServer();
    const admitted: Array<RelayClientIdentity> = [];
    using host = startHost(relay.url, local.url, async (client) => {
      admitted.push(client);
      return { kind: "pending", decision: new Promise<RelayAdmission>(() => {}) };
    });
    await host.online;
    const controller = new AbortController();
    const pending = Promise.withResolvers<void>();
    const connecting = connect(relay.url, host.hostKey, {
      peerLink: { access: "auto" },
      onPending: () => pending.resolve(),
      signal: controller.signal,
    });
    await pending.promise;
    expect(admitted[0]?.hello.peerLink).toEqual({ access: "auto" });
    controller.abort();
    await expect(connecting).rejects.toMatchObject({ reason: "closed" });
    await admitted[0]!.closed;
  });

  it("trusts the key a computer presents only when asked to, and reports it", async () => {
    await using relay = await startRelay();
    await using local = await startLocalServer();
    using host = startHost(relay.url, local.url, async () => ({ kind: "ready" }));
    await host.online;
    const client = await connect(relay.url, null);
    expect(toBase64Url(client.remoteStaticKey)).toBe(host.hostKey);
    client.close();
  });

  it.live(
    "pairs and authenticates a DPoP-bound client over HTTP and WebSocket through the relay",
    () => {
      class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}
      const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "relay-dpop-test-" });
      const layerBase = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
      const layerSecrets = ServerSecretStore.layer.pipe(
        Layer.provide(layerConfig),
        Layer.provide(layerBase),
      );
      const layerAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(layerSecrets),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
        Layer.provide(layerBase),
      );
      return Effect.gen(function* () {
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessionStore = yield* SessionStore.SessionStore;
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const pairing = yield* serverAuth.createPairingLink({ label: "Pixel" });
        const nowMs = yield* Clock.currentTimeMillis;
        yield* Effect.promise(async () => {
          const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
            Layer.provide(AuthHttp.layer),
            Layer.provide(AuthHttp.layerAuthenticatedAuth),
            Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, serverAuth)),
            Layer.provideMerge(Layer.succeed(SessionStore.SessionStore, sessionStore)),
            Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
            Layer.provide(layerConfig),
            Layer.provideMerge(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(layerBase),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
            Layer.provideMerge(layerBase),
          );

          const webApp = HttpRouter.toWebHandler(layerRoutes, { disableLogger: true });
          const localServer = NodeHttp.createServer(async (req, res) => {
            try {
              const chunks: Array<Buffer> = [];
              for await (const chunk of req) chunks.push(chunk as Buffer);
              const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
              const headers = new Headers();
              for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === "string") headers.set(key, value);
                else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
              }
              const webRequest = new Request(
                `http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`,
                {
                  method: req.method ?? "GET",
                  headers,
                  ...(req.method === "GET" || req.method === "HEAD" ? {} : { body }),
                },
              );
              const webResponse = await webApp.handler(webRequest);
              res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
              res.end(Buffer.from(await webResponse.arrayBuffer()));
            } catch (error) {
              res.writeHead(500).end(String(error));
            }
          });
          const wss = new WebSocketServer({ noServer: true });
          let upgradeFailure: unknown = null;
          localServer.on("upgrade", (req, socket, head) => {
            const upgradeHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
              if (typeof value === "string") upgradeHeaders[key] = value;
              else if (Array.isArray(value)) upgradeHeaders[key] = value.join(", ");
            }
            const upgradeRequest = HttpServerRequest.fromWeb(
              new Request(`http://${req.headers.host ?? "127.0.0.1"}${req.url ?? "/"}`),
            ).modify({ headers: HttpHeaders.fromInput(upgradeHeaders) });
            // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Node http.Server upgrade event callback bridges into Effect.
            void Effect.runPromise(
              serverAuth.authenticateWebSocketUpgrade(upgradeRequest, "rpc"),
            ).then(
              (session) => {
                wss.handleUpgrade(req, socket, head, (ws) => {
                  ws.on("message", (data) =>
                    ws.send(`authed:${session.method}:${data.toString()}`),
                  );
                });
              },
              (error) => {
                upgradeFailure = error;
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
              },
            );
          });
          localServer.listen(0, "127.0.0.1");
          await NodeEvents.EventEmitter.once(localServer, "listening");
          const localOrigin = `http://127.0.0.1:${(localServer.address() as NodeNet.AddressInfo).port}`;

          try {
            await using relay = await startRelay();
            using host = startHost(relay.url, localOrigin, async () => ({
              kind: "ready",
              pairingToken: pairing.credential,
            }));
            await host.online;

            const client = await connect(relay.url, host.hostKey);
            try {
              const baseUrl = relayVirtualBaseUrl("laptop");
              const dpop = makeDpopKey();
              const now = Math.floor(nowMs / 1_000);

              const tokenUrl = `${baseUrl}/oauth/token`;
              const tokenResponse = await client.fetch(tokenUrl, {
                method: "POST",
                headers: {
                  "content-type": "application/x-www-form-urlencoded",
                  dpop: dpop.sign({ method: "POST", url: tokenUrl, token: "", iat: now }),
                },
                body: new URLSearchParams({
                  grant_type: AuthTokenExchangeGrantType,
                  subject_token: client.pairingToken!,
                  subject_token_type: AuthEnvironmentBootstrapTokenType,
                  requested_token_type: AuthAccessTokenType,
                }).toString(),
              });
              const tokenBodyText = await tokenResponse.text();
              expect(tokenResponse.status, tokenBodyText).toBe(200);
              const tokenBody = JSON.parse(tokenBodyText) as {
                access_token: string;
                token_type: string;
              };
              expect(tokenBody.token_type).toBe("DPoP");

              const ticketUrl = `${baseUrl}/api/auth/websocket-ticket/rpc`;
              const ticketResponse = await client.fetch(ticketUrl, {
                method: "POST",
                headers: {
                  authorization: `DPoP ${tokenBody.access_token}`,
                  dpop: dpop.sign({
                    method: "POST",
                    url: ticketUrl,
                    token: tokenBody.access_token,
                    iat: now,
                  }),
                },
              });
              expect(ticketResponse.status).toBe(200);
              const ticketBody = (await ticketResponse.json()) as { ticket: string };

              const wsUpgradeProof = dpop.sign({
                method: "GET",
                url: `${baseUrl}/ws`,
                token: ticketBody.ticket,
                iat: now,
              });
              const wsUrl = new URL(`${baseUrl.replace("https:", "wss:")}/ws`);
              wsUrl.searchParams.set("wsTicket", ticketBody.ticket);
              wsUrl.searchParams.set("dpop", wsUpgradeProof);
              const socket = client.createWebSocket(wsUrl);
              const reply = Promise.withResolvers<unknown>();
              socket.addEventListener("open", () => socket.send("hello"));
              socket.addEventListener("message", (event) => reply.resolve(event.data));
              socket.addEventListener("error", () =>
                reply.reject(new Error(`WebSocket upgrade failed: ${String(upgradeFailure)}`)),
              );
              socket.addEventListener("close", () =>
                reply.reject(new Error(`WebSocket closed before reply: ${String(upgradeFailure)}`)),
              );
              expect(await reply.promise).toBe("authed:dpop-access-token:hello");
              socket.close();
            } finally {
              client.close();
            }
          } finally {
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            localServer.closeAllConnections();
            localServer.close();
            await webApp.dispose();
          }
        });
      }).pipe(Effect.provide(Layer.mergeAll(layerAuth, layerSecrets, layerBase)));
    },
  );
});
