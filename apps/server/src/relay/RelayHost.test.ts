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

/** A session of the fake auth: a pairing link's label stands for the session it opens. */
interface HeldSession {
  readonly sessionId: string;
  readonly client: { readonly label?: string | undefined };
}

function layer(
  options: {
    readonly linkedEnvironments?: boolean;
    readonly refuseAccess?: string;
    readonly approvalTtlMs?: number;
    /** Where the fake auth keeps its sessions, for a test to read. */
    readonly held?: Array<HeldSession>;
  } = {},
) {
  let issued = 0;
  const held = options.held ?? [];
  return RelayHost.layerWith({ approvalTtlMs: options.approvalTtlMs }).pipe(
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, memorySecretStore())),
    Layer.provide(
      Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
        createPairingLink: (input?: { readonly label?: string }) =>
          Effect.sync(() => {
            const credential = `CODE-${++issued}`;
            held.push({ sessionId: credential, client: { label: input?.label } });
            return { credential };
          }),
        listSessions: () => Effect.sync(() => [...held]),
        revokeSession: (sessionId: string) =>
          Effect.sync(() => {
            const index = held.findIndex((session) => session.sessionId === sessionId);
            if (index >= 0) held.splice(index, 1);
            return index >= 0;
          }),
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

/** A device of the same account asking to pair from its computer list: no QR code, no key for the computer yet. */
const connectAccount = (
  relayUrl: string,
  clientKeyPair: NoiseKeyPair,
  extra: { onPending?: (hostKey: Uint8Array) => void } = {},
) =>
  Effect.promise(() =>
    RelayTunnelClient.connect({
      relayUrl,
      deviceToken: PHONE_TOKEN,
      hostDeviceId: "laptop",
      hostKey: null,
      clientKeyPair,
      name: "Pixel",
      accountPairing: true,
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

/** Waits until the computer has the request in front of its user, and returns it. */
const askedUser = (host: RelayHost.RelayHost["Service"]) => {
  const asked = Promise.withResolvers<Uint8Array>();
  return {
    onPending: asked.resolve,
    waiting: Effect.gen(function* () {
      const hostKey = yield* Effect.promise(() => asked.promise);
      return { hostKey, pending: (yield* host.status()).pending };
    }),
  };
};

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

  // The account's token proves nothing about who is at the other end, so a pairing asked from the
  // account's computer list waits for this computer's user, with the code both screens show.
  it.live("pairs a phone picked from the account's computers only after the user allows it", () => {
    const held: Array<HeldSession> = [];
    return Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const phone = generateNoiseKeyPair(random);

      const ask = askedUser(host);
      const pairing = yield* Effect.forkChild(
        connectAccount(relay.url, phone, { onPending: ask.onPending }),
      );
      const { hostKey, pending } = yield* ask.waiting;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        name: "Pixel",
        viaAccount: true,
        safetyCode: relaySafetyCode(phone.publicKey, hostKey),
      });
      expect(pending[0]?.peerLink).toBeUndefined();
      // Nothing was issued or remembered while it waits.
      expect((yield* host.status()).devices).toEqual([]);
      expect(held).toEqual([]);

      yield* host.decide({ id: pending[0]!.id, approve: true });
      expect(yield* Fiber.join(pairing)).toEqual({
        pairingToken: "CODE-1",
        hostKey: toBase64Url(hostKey),
      });
      const [device] = (yield* host.status()).devices;
      expect(device).toMatchObject({ name: "Pixel", trusted: true });
      const key = toBase64Url(phone.publicKey);
      expect(held.map((session) => session.client.label)).toEqual([
        `Pixel (relay ${key.slice(0, 12)})`,
      ]);
      // The key now opens the tunnel by itself, as after a scan.
      expect(yield* connect(relay.url, toBase64Url(hostKey), phone)).toEqual({
        pairingToken: null,
      });
    }).pipe(Effect.scoped, Effect.provide(layer({ held })));
  });

  it.live("drops an account pairing the user declines", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());

      const ask = askedUser(host);
      const declined = yield* Effect.forkChild(
        connectAccount(relay.url, generateNoiseKeyPair(random), { onPending: ask.onPending }),
      );
      const { pending } = yield* ask.waiting;
      yield* host.decide({ id: pending[0]!.id, approve: false });
      expect(yield* Fiber.join(declined)).toEqual({ failed: "rejected" });
      expect((yield* host.status()).devices).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("ends an account pairing nobody answered in time", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      expect(yield* connectAccount(relay.url, generateNoiseKeyPair(random))).toEqual({
        failed: "rejected",
      });
      expect((yield* host.status()).pending).toEqual([]);
      expect((yield* host.status()).devices).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer({ approvalTtlMs: 0 }))),
  );

  it.live("keeps only a few account pairings waiting, one per device, apart from links", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const keys = [1, 2, 3].map(() => generateNoiseKeyPair(random));
      const fibers = [];
      for (const key of keys) {
        const ask = askedUser(host);
        fibers.push(
          yield* Effect.forkChild(connectAccount(relay.url, key, { onPending: ask.onPending })),
        );
        yield* ask.waiting;
      }
      // The same device again, and a fourth one, find the queue full.
      expect(yield* connectAccount(relay.url, keys[0]!)).toEqual({ failed: "busy" });
      expect(yield* connectAccount(relay.url, generateNoiseKeyPair(random))).toEqual({
        failed: "busy",
      });
      // Requests to link have a queue of their own, so a flood of one cannot starve the other.
      const linkAsked = Promise.withResolvers<Uint8Array>();
      fibers.push(
        yield* Effect.forkChild(
          connectPeer(relay.url, generateNoiseKeyPair(random), { onPending: linkAsked.resolve }),
        ),
      );
      yield* Effect.promise(() => linkAsked.promise);
      expect((yield* host.status()).pending).toHaveLength(4);
      for (const waiting of (yield* host.status()).pending) {
        yield* host.decide({ id: waiting.id, approve: false });
      }
      for (const fiber of fibers) expect(yield* Fiber.join(fiber)).toEqual({ failed: "rejected" });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  // "Trust my other devices" skips the prompt for a key the user already allowed by hand, and
  // for nothing else: an account's stolen token cannot add a device.
  it.live("trusts only keys already allowed as a client, and only while it is on", () => {
    const held: Array<HeldSession> = [];
    return Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      const phone = generateNoiseKeyPair(random);
      const phoneKey = toBase64Url(phone.publicKey);
      const answer = (approve: boolean) =>
        Effect.gen(function* () {
          const [waiting] = (yield* host.status()).pending;
          yield* host.decide({ id: waiting!.id, approve });
        });
      const pairByHand = Effect.gen(function* () {
        const ask = askedUser(host);
        const pairing = yield* Effect.forkChild(
          connectAccount(relay.url, phone, { onPending: ask.onPending }),
        );
        yield* ask.waiting;
        yield* answer(true);
        return yield* Fiber.join(pairing);
      });

      expect((yield* host.status()).trustOtherDevices).toBe(false);
      expect(yield* pairByHand).toMatchObject({ pairingToken: "CODE-1" });

      // Off: the same key is asked again.
      expect(yield* pairByHand).toMatchObject({ pairingToken: "CODE-2" });

      expect((yield* host.setTrust({ enabled: true })).trustOtherDevices).toBe(true);
      // On: the pinned key gets the same pairing with no one asked.
      expect(yield* connectAccount(relay.url, phone)).toMatchObject({ pairingToken: "CODE-3" });
      expect((yield* host.status()).pending).toEqual([]);
      expect(held.map((session) => session.client.label)).toEqual([
        `Pixel (relay ${phoneKey.slice(0, 12)})`,
        `Pixel (relay ${phoneKey.slice(0, 12)})`,
        `Pixel (relay ${phoneKey.slice(0, 12)} · trusted)`,
      ]);

      // A new key always waits for a person.
      const stranger = generateNoiseKeyPair(random);
      const ask = askedUser(host);
      const strange = yield* Effect.forkChild(
        connectAccount(relay.url, stranger, { onPending: ask.onPending }),
      );
      expect((yield* ask.waiting).pending).toHaveLength(1);
      yield* answer(false);
      expect(yield* Fiber.join(strange)).toEqual({ failed: "rejected" });

      // A pinned phone linking its agents is asked too: trust never covers links.
      const linkAsk = Promise.withResolvers<Uint8Array>();
      const linking = yield* Effect.forkChild(
        connectPeer(relay.url, phone, { onPending: linkAsk.resolve }),
      );
      yield* Effect.promise(() => linkAsk.promise);
      expect((yield* host.status()).pending[0]?.peerLink).toEqual({ access: "auto" });
      yield* answer(false);
      expect(yield* Fiber.join(linking)).toEqual({ failed: "rejected" });

      // Turning it off ends the session nobody was asked about, not the ones allowed by hand.
      yield* host.setTrust({ enabled: false });
      expect(held.map((session) => session.sessionId)).toEqual(["CODE-1", "CODE-2"]);
      const afterOff = askedUser(host);
      const asked = yield* Effect.forkChild(
        connectAccount(relay.url, phone, { onPending: afterOff.onPending }),
      );
      yield* afterOff.waiting;
      yield* answer(false);
      expect(yield* Fiber.join(asked)).toEqual({ failed: "rejected" });
    }).pipe(Effect.scoped, Effect.provide(layer({ held })));
  });

  it.live("never trusts a key that was only ever allowed as a linked machine", () =>
    Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      yield* host.setTrust({ enabled: true });
      const mac = generateNoiseKeyPair(random);
      const linkAsk = Promise.withResolvers<Uint8Array>();
      const linking = yield* Effect.forkChild(
        connectPeer(relay.url, mac, { onPending: linkAsk.resolve }),
      );
      yield* Effect.promise(() => linkAsk.promise);
      yield* host.decide({ id: (yield* host.status()).pending[0]!.id, approve: true });
      yield* Fiber.join(linking);
      expect((yield* host.status()).devices).toMatchObject([{ name: "Pixel", trusted: false }]);

      // It is a pinned key, yet pairing as a client still waits for a person.
      const ask = askedUser(host);
      const pairing = yield* Effect.forkChild(
        connectAccount(relay.url, mac, { onPending: ask.onPending }),
      );
      expect((yield* ask.waiting).pending[0]).toMatchObject({ viaAccount: true });
      yield* host.decide({ id: (yield* host.status()).pending[0]!.id, approve: false });
      expect(yield* Fiber.join(pairing)).toEqual({ failed: "rejected" });
    }).pipe(Effect.scoped, Effect.provide(layer())),
  );

  it.live("revoking a device ends its tunnel, its sessions and anything it still waits on", () => {
    const held: Array<HeldSession> = [];
    return Effect.gen(function* () {
      const relay = yield* Effect.acquireDisposable(Effect.promise(startRelay));
      const host = yield* RelayHost.RelayHost;
      yield* host.setCredential({ relayUrl: relay.url, deviceId: "laptop", token: HOST_TOKEN });
      yield* Effect.promise(() => relay.nextHost());
      yield* host.setTrust({ enabled: true });
      const phone = generateNoiseKeyPair(random);
      const ask = askedUser(host);
      const pairing = yield* Effect.forkChild(
        connectAccount(relay.url, phone, { onPending: ask.onPending }),
      );
      const { hostKey, pending } = yield* ask.waiting;
      yield* host.decide({ id: pending[0]!.id, approve: true });
      yield* Fiber.join(pairing);
      // A second session from the trusted path, and one from another device that must survive.
      yield* connectAccount(relay.url, phone);
      held.push({ sessionId: "OTHER", client: { label: "Tablet (relay abcdefghijkl)" } });
      held.push({ sessionId: "OLD", client: { label: "Pixel (relay)" } });
      expect(held).toHaveLength(4);

      const open = yield* Effect.promise(() =>
        RelayTunnelClient.connect({
          relayUrl: relay.url,
          deviceToken: PHONE_TOKEN,
          hostDeviceId: "laptop",
          hostKey: toBase64Url(hostKey),
          clientKeyPair: phone,
          name: "Pixel",
          randomBytes: random,
        }),
      );
      const closed = Promise.withResolvers<string>();
      open.onClose((error) => closed.resolve(error.reason));
      const [device] = (yield* host.status()).devices;
      yield* host.revokeDevice({ key: device!.key });

      expect(yield* Effect.promise(() => closed.promise)).toBe("closed");
      expect(held.map((session) => session.sessionId)).toEqual(["OTHER"]);
      expect((yield* host.status()).devices).toEqual([]);
      // With the key gone, trust has nothing to skip: the phone is a stranger again.
      const again = askedUser(host);
      const retry = yield* Effect.forkChild(
        connectAccount(relay.url, phone, { onPending: again.onPending }),
      );
      expect((yield* again.waiting).pending).toHaveLength(1);
      yield* host.decide({ id: (yield* host.status()).pending[0]!.id, approve: false });
      yield* Fiber.join(retry);
    }).pipe(Effect.scoped, Effect.provide(layer({ held })));
  });
});
