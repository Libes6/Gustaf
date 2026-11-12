import {
  RelayTunnelClient,
  RelayTunnelClientError,
  RelayTunnelPool,
  relayVirtualBaseUrl,
} from "@t3tools/shared/relayTunnelClient";
import { generateNoiseKeyPair } from "@t3tools/shared/relayNoise";
import { toBase64Url } from "@t3tools/shared/relayTunnel";
import { describe, expect, it } from "@effect/vitest";

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
    approve.resolve({ kind: "ready", pairingToken: "PAIRCODE1" });
    const client = await connecting;
    expect(client.pairingToken).toBe("PAIRCODE1");

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
});
