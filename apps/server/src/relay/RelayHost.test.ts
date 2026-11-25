import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  generateNoiseKeyPair,
  type NoiseKeyPair,
  relaySafetyCode,
} from "@t3tools/shared/relayNoise";
import { parseRelayPairingLink, toBase64Url } from "@t3tools/shared/relayTunnel";
import { RelayTunnelClient } from "@t3tools/shared/relayTunnelClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ServerSettings from "../serverSettings.ts";
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

function layer(
  options: { readonly linkedEnvironments?: boolean; readonly refuseAccess?: string } = {},
) {
  let issued = 0;
  return RelayHost.layer.pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, memorySecretStore())),
    Layer.provide(
      Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
        createPairingLink: () => Effect.sync(() => ({ credential: `CODE-${++issued}` })),
        issuePairingCredential: (input?: { readonly access?: string }) =>
          input?.access !== undefined && input.access === options.refuseAccess
            ? Effect.fail(
                new ManagedLimits.ManagedPolicyRefusedError({
                  organization: "Acme",
                  action: "full-access links",
                }),
              )
            : Effect.sync(() => ({ credential: `LINK-${input?.access}-${++issued}` })),
      } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
    ),
    Layer.provide(
      ServerSettings.layerTest({ linkedEnvironmentsEnabled: options.linkedEnvironments ?? true }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "relay-host-test-" })),
    Layer.provide(NodeServices.layer),
  );
}

const connect = (
  relayUrl: string,
  hostKey: string,
  clientKeyPair: NoiseKeyPair,
  extra: {
    pairingSecret?: string;
    peerLink?: { access: string };
    onPending?: () => void;
  } = {},
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

/** A machine of the same account asking to link its agents, with no key for the computer yet. */
const connectPeer = (
  relayUrl: string,
  clientKeyPair: NoiseKeyPair,
  extra: { access?: string; onPending?: (hostKey: Uint8Array) => void },
) =>
  Effect.promise(() =>
    RelayTunnelClient.connect({
      relayUrl,
      deviceToken: PHONE_TOKEN,
      hostDeviceId: "laptop",
      hostKey: null,
      clientKeyPair,
      name: "Pixel",
      peerLink: { access: extra.access ?? "auto" },
      randomBytes: random,
      ...(extra.onPending ? { onPending: extra.onPending } : {}),
    }).then(
      (client) => {
        client.close();
        return {
          pairingToken: client.pairingToken ?? null,
          hostKey: toBase64Url(client.remoteStaticKey),
        } as const;
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
      expect(yield* connect(relay.url, offer.hostKey, phone)).toEqual({ failed: "unknown_device" });
      expect(
        yield* connect(relay.url, offer.hostKey, phone, { pairingSecret: "x".repeat(32) }),
      ).toEqual({ failed: "unknown_device" });

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
      expect(yield* connect(relay.url, offer.hostKey, phone)).toEqual({ failed: "unknown_device" });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  // The account's token proves nothing about who is at the other end, so a request to link waits
  // for this computer's user every time, whether or not the machine is known.
  it.live("holds a request to link agents until the user allows that access", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const mac = generateNoiseKeyPair(random);

      const asked = Promise.withResolvers<Uint8Array>();
      const linking = yield* Effect.forkChild(
        connectPeer(relay.url, mac, { access: "auto", onPending: asked.resolve }),
      );
      const hostKey = yield* Effect.promise(() => asked.promise);
      const waiting = (yield* host.status()).pending;
      expect(waiting).toHaveLength(1);
      // Both screens derive the code from the two keys, so matching codes rule out a relay in the middle.
      expect(waiting[0]).toMatchObject({
        name: "Pixel",
        peerLink: { access: "auto" },
        safetyCode: relaySafetyCode(mac.publicKey, hostKey),
      });
      yield* host.decide({ id: waiting[0]!.id, approve: true });
      expect(yield* Fiber.join(linking)).toEqual({
        pairingToken: "LINK-auto-1",
        hostKey: toBase64Url(hostKey),
      });

      // The key now opens the tunnel by itself, which is what lets a link reconnect.
      expect(yield* connect(relay.url, toBase64Url(hostKey), mac)).toEqual({ pairingToken: null });

      // A known device asking to link again is asked about again: each link session is consented to.
      const askedAgain = Promise.withResolvers<Uint8Array>();
      const second = yield* Effect.forkChild(
        connectPeer(relay.url, mac, { access: "full-access", onPending: askedAgain.resolve }),
      );
      yield* Effect.promise(() => askedAgain.promise);
      const [again] = (yield* host.status()).pending;
      expect(again?.peerLink).toEqual({ access: "full-access" });
      yield* host.decide({ id: again!.id, approve: false });
      expect(yield* Fiber.join(second)).toEqual({ failed: "rejected" });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("turns a link request away while linked environments is off", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      expect(yield* connectPeer(relay.url, generateNoiseKeyPair(random), {})).toEqual({
        failed: "linking_off",
      });
      expect((yield* host.status()).pending).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer({ linkedEnvironments: false }))),
  );

  it.live("keeps only a few link requests waiting, one per device", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const keys = [1, 2, 3].map(() => generateNoiseKeyPair(random));
      const fibers = [];
      for (const key of keys) {
        const asked = Promise.withResolvers<Uint8Array>();
        fibers.push(
          yield* Effect.forkChild(connectPeer(relay.url, key, { onPending: asked.resolve })),
        );
        yield* Effect.promise(() => asked.promise);
      }
      // The same device again, and a fourth one, find the queue full.
      expect(yield* connectPeer(relay.url, keys[0]!, {})).toEqual({ failed: "busy" });
      expect(yield* connectPeer(relay.url, generateNoiseKeyPair(random), {})).toEqual({
        failed: "busy",
      });
      for (const pending of (yield* host.status()).pending) {
        yield* host.decide({ id: pending.id, approve: false });
      }
      for (const fiber of fibers) expect(yield* Fiber.join(fiber)).toEqual({ failed: "rejected" });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("tells the requester when the computer's policy refuses the access", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const asked = Promise.withResolvers<Uint8Array>();
      const linking = yield* Effect.forkChild(
        connectPeer(relay.url, generateNoiseKeyPair(random), {
          access: "full-access",
          onPending: asked.resolve,
        }),
      );
      yield* Effect.promise(() => asked.promise);
      const [pending] = (yield* host.status()).pending;
      const decided = yield* host.decide({ id: pending!.id, approve: true }).pipe(Effect.flip);
      expect(decided.reason).toBe("policy");
      expect(yield* Fiber.join(linking)).toEqual({ failed: "policy" });
      expect((yield* host.status()).devices).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer({ refuseAccess: "full-access" }))),
  );
});
