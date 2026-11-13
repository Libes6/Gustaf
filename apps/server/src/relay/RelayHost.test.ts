import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { generateNoiseKeyPair, type NoiseKeyPair } from "@t3tools/shared/relayNoise";
import { parseRelayPairingLink, toBase64Url } from "@t3tools/shared/relayTunnel";
import { RelayTunnelClient } from "@t3tools/shared/relayTunnelClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as RelayHost from "./RelayHost.ts";
import { HOST_TOKEN, PHONE_TOKEN, random, startRelay } from "./RelayHost.testkit.ts";

function memorySecretStore() {
  const secrets = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        if (!secrets.has(name)) secrets.set(name, random(bytes));
        return secrets.get(name)!;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });
}

function layer() {
  let issued = 0;
  return RelayHost.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, memorySecretStore())),
    Layer.provide(
      Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
        createPairingLink: () => Effect.sync(() => ({ credential: `CODE-${++issued}` })),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "relay-host-test-" })),
    Layer.provide(NodeServices.layer),
  );
}

const connect = (
  relayUrl: string,
  hostKey: string,
  clientKeyPair: NoiseKeyPair,
  extra: { pairingSecret?: string; onPending?: () => void } = {},
) =>
  Effect.promise(() =>
    RelayTunnelClient.connect({
      relayUrl,
      deviceToken: PHONE_TOKEN,
      hostDeviceId: "laptop",
      hostKey,
      clientKeyPair,
      name: "Pixel",
      randomBytes: random,
      ...extra,
    }).then(
      (client) => {
        client.close();
        return { pairingToken: client.pairingToken ?? null } as const;
      },
      (error: unknown) => ({ failed: (error as { reason: string }).reason }) as const,
    ),
  );

describe("RelayHost", () => {
  // Live: real sockets to a loopback relay.
  it.live("admits a new phone once per QR code and only after the user allows it", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      const phone = generateNoiseKeyPair(random);
      // Any answer to a handshake proves the host processed the relay's "ready" before it.
      const stranger = toBase64Url(generateNoiseKeyPair(random).publicKey);
      expect(yield* connect(relay.url, stranger, phone)).toEqual({ failed: "handshake_failed" });

      const offer = parseRelayPairingLink((yield* host.createOffer()).link)!;
      expect(yield* connect(relay.url, offer.hostKey, phone)).toEqual({ failed: "closed" });
      expect(
        yield* connect(relay.url, offer.hostKey, phone, { pairingSecret: "x".repeat(32) }),
      ).toEqual({ failed: "closed" });

      const asked = Promise.withResolvers<void>();
      const pairing = yield* Effect.forkChild(
        connect(relay.url, offer.hostKey, phone, {
          pairingSecret: offer.secret,
          onPending: () => asked.resolve(),
        }),
      );
      yield* Effect.promise(() => asked.promise);
      const status = yield* host.status();
      expect(status.offer).toBeUndefined();
      expect(status.pending.map((pending) => pending.name)).toEqual(["Pixel"]);
      yield* host.decide({ id: status.pending[0]!.id, approve: true });
      expect(yield* Fiber.join(pairing)).toEqual({ pairingToken: "CODE-1" });
      expect((yield* host.status()).devices.map((device) => device.name)).toEqual(["Pixel"]);

      // An allowed phone reconnects with its key alone, and a rescan needs no second approval.
      expect(yield* connect(relay.url, offer.hostKey, phone)).toEqual({ pairingToken: null });
      const rescan = parseRelayPairingLink((yield* host.createOffer()).link)!;
      expect(
        yield* connect(relay.url, offer.hostKey, phone, { pairingSecret: rescan.secret }),
      ).toEqual({ pairingToken: "CODE-2" });

      const [device] = (yield* host.status()).devices;
      yield* host.revokeDevice({ key: device!.key });
      expect(yield* connect(relay.url, offer.hostKey, phone)).toEqual({ failed: "closed" });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );
});
