// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The relay engine runs outside the Effect runtime; a pending approval is a Promise it awaits.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import type {
  RelayHostCredentialInput,
  RelayHostDevice,
  RelayHostPairingOffer,
  RelayHostPendingDevice,
  RelayHostStatus,
} from "@t3tools/contracts";
import { bytesEqual, noiseKeyPairFromSecret, relaySafetyCode } from "@t3tools/shared/relayNoise";
import { formatRelayPairingLink, fromBase64Url, toBase64Url } from "@t3tools/shared/relayTunnel";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  type RelayAdmission,
  type RelayHostConnectionState,
  RelayHostEngine,
} from "./RelayHostEngine.ts";

export class RelayHostError extends Schema.TaggedError<RelayHostError>()("RelayHostError", {
  reason: Schema.Literals(["not_online", "not_found", "invalid_relay_url", "storage"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "not_online":
        return "This computer is not connected to the relay.";
      case "not_found":
        return "That device is no longer listed.";
      case "invalid_relay_url":
        return "The relay address must be an https origin.";
      case "storage":
        return "Could not read or write the relay settings.";
    }
  }
}

export class RelayHost extends Context.Service<
  RelayHost,
  {
    readonly status: () => Effect.Effect<RelayHostStatus>;
    readonly setCredential: (
      input: RelayHostCredentialInput,
    ) => Effect.Effect<RelayHostStatus, RelayHostError>;
    readonly clearCredential: () => Effect.Effect<RelayHostStatus, RelayHostError>;
    readonly createOffer: () => Effect.Effect<RelayHostPairingOffer, RelayHostError>;
    readonly decide: (input: {
      readonly id: string;
      readonly approve: boolean;
    }) => Effect.Effect<RelayHostStatus, RelayHostError>;
    readonly revokeDevice: (input: {
      readonly key: string;
    }) => Effect.Effect<RelayHostStatus, RelayHostError>;
  }
>()("t3/relay/RelayHost") {}

const HOST_KEY_SECRET = "relay-host-key";
const CREDENTIAL_SECRET = "relay-host-credential";
const DEVICES_SECRET = "relay-host-devices";
const OFFER_TTL = Duration.minutes(5);
const APPROVAL_TTL_MS = 5 * 60_000;
// The approved phone redeems it through the tunnel within seconds.
const PAIRING_TOKEN_TTL = Duration.minutes(5);

const StoredCredential = Schema.Struct({
  relayUrl: Schema.String,
  deviceId: Schema.String,
  token: Schema.String,
});
type StoredCredential = typeof StoredCredential.Type;
const StoredDevice = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  approvedAt: Schema.String,
});
type StoredDevice = typeof StoredDevice.Type;
const StoredDevices = Schema.Array(StoredDevice);

interface PendingApproval {
  readonly view: RelayHostPendingDevice;
  readonly key: string;
  readonly settle: (admission: RelayAdmission) => void;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const decodeStoredCredential = Schema.decodeUnknownOption(StoredCredential);
const decodeStoredDevices = Schema.decodeUnknownOption(StoredDevices);
const decodeCredential = (text: string) => decodeStoredCredential(parseJson(text));

/** This computer's Gustaf cloud device credential, which the desktop shell hands over. */
export const readCloudCredential = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  secrets.get(CREDENTIAL_SECRET).pipe(
    Effect.map(Option.flatMap((bytes) => decodeCredential(new TextDecoder().decode(bytes)))),
    Effect.orElseSucceed(() => Option.none<StoredCredential>()),
  );
const decodeDevices = (text: string) => decodeStoredDevices(parseJson(text));
const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

export function readRelayUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The host may be bound to every interface; tunneled requests always come from this machine. */
export function localOrigin(host: string | undefined, port: number) {
  const address =
    host === undefined || host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${address.includes(":") && !address.startsWith("[") ? `[${address}]` : address}:${port}`;
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const hostKeyPair = noiseKeyPairFromSecret(
    yield* secrets.getOrCreateRandom(HOST_KEY_SECRET, 32).pipe(Effect.orDie),
  );
  const hostKey = toBase64Url(hostKeyPair.publicKey);
  const readText = (name: string) =>
    secrets.get(name).pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));
  let credential: StoredCredential | null = yield* readText(CREDENTIAL_SECRET).pipe(
    Effect.map(Option.flatMap(decodeCredential)),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
  let devices: ReadonlyArray<StoredDevice> = yield* readText(DEVICES_SECRET).pipe(
    Effect.map(Option.flatMap(decodeDevices)),
    Effect.map(Option.getOrElse((): ReadonlyArray<StoredDevice> => [])),
    Effect.orElseSucceed((): ReadonlyArray<StoredDevice> => []),
  );
  let connection: RelayHostConnectionState | null = null;
  let engine: RelayHostEngine | null = null;
  let offer: { secret: string; view: RelayHostPairingOffer } | null = null;
  const pending = new Map<string, PendingApproval>();

  const storageError = (cause: unknown) => new RelayHostError({ reason: "storage", cause });
  const saveDevices = (next: ReadonlyArray<StoredDevice>) =>
    secrets.set(DEVICES_SECRET, encodeJson(next)).pipe(
      Effect.mapError(storageError),
      Effect.tap(() =>
        Effect.sync(() => {
          devices = next;
        }),
      ),
    );

  const safetyCode = (key: string) => relaySafetyCode(hostKeyPair.publicKey, fromBase64Url(key));

  const status = (): Effect.Effect<RelayHostStatus> =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      if (offer && Date.parse(offer.view.expiresAt) <= now) offer = null;
      const state: RelayHostConnectionState | { status: "disabled" } = credential
        ? (connection ?? { status: "connecting" })
        : { status: "disabled" };
      return {
        connection: state.status,
        ...("error" in state ? { error: state.error } : {}),
        ...(credential ? { relayUrl: credential.relayUrl, deviceId: credential.deviceId } : {}),
        devices: devices.map((device): RelayHostDevice => ({
          key: device.key,
          name: device.name,
          approvedAt: device.approvedAt,
          safetyCode: safetyCode(device.key),
        })),
        pending: [...pending.values()].map((approval) => approval.view),
        ...(offer ? { offer: offer.view } : {}),
      };
    });

  // The phone pairs through the tunnel like over any other route and gets an ordinary session.
  const issuePairingToken = (name: string) =>
    auth.createPairingLink({ ttl: PAIRING_TOKEN_TTL, label: `${name} (relay)` });

  const ready = (pairingToken?: string): RelayAdmission =>
    pairingToken === undefined ? { kind: "ready" } : { kind: "ready", pairingToken };
  const reject = (reason: string): RelayAdmission => ({ kind: "reject", reason });

  const waitForUser = (key: string, name: string): RelayAdmission => {
    const id = NodeCrypto.randomUUID();
    const decision = new Promise<RelayAdmission>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(reject("rejected"));
      }, APPROVAL_TTL_MS);
      pending.set(id, {
        key,
        view: { id, name, requestedAt: new Date().toISOString(), safetyCode: safetyCode(key) },
        settle: (admission) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(admission);
        },
      });
    });
    return { kind: "pending", decision };
  };

  /** Runs inside the engine's callback: decides about a client whose handshake completed. */
  const admit = Effect.fn("RelayHost.admit")(function* (client: {
    readonly clientKey: string;
    readonly hello: { readonly name: string; readonly pairingSecret?: string };
  }) {
    const now = yield* Clock.currentTimeMillis;
    const known = devices.some((device) => device.key === client.clientKey);
    const secret = client.hello.pairingSecret;
    const current = offer;
    const scanned =
      secret !== undefined &&
      current !== null &&
      Date.parse(current.view.expiresAt) > now &&
      bytesEqual(new TextEncoder().encode(secret), new TextEncoder().encode(current.secret));
    if (!scanned) return known ? ready() : reject("unknown_device");
    // One scan, one device: a second phone needs a fresh code.
    offer = null;
    // An allowed phone that scans again (say, after removing the computer) needs no new approval.
    if (known) return ready((yield* issuePairingToken(client.hello.name)).credential);
    return waitForUser(client.clientKey, client.hello.name);
  });

  const stopEngine = () => {
    engine?.stop();
    engine = null;
    connection = null;
    for (const approval of pending.values())
      approval.settle({ kind: "reject", reason: "rejected" });
  };

  const startEngine = () => {
    stopEngine();
    if (!credential) return;
    const started = new RelayHostEngine({
      relayUrl: credential.relayUrl,
      deviceToken: credential.token,
      hostKeyPair,
      randomBytes: (length) => new Uint8Array(NodeCrypto.randomBytes(length)),
      localOrigin: localOrigin(config.host, config.port),
      admit: (client) => runPromise(admit(client)),
      onState: (state) => {
        if (engine === started) connection = state;
      },
      log: (message, detail) => void runPromise(Effect.logInfo(message, detail ?? {})),
    });
    engine = started;
    started.start();
  };

  yield* Effect.addFinalizer(() => Effect.sync(stopEngine));
  startEngine();

  const setCredential: RelayHost["Service"]["setCredential"] = Effect.fn("RelayHost.setCredential")(
    function* (input) {
      const relayUrl = readRelayUrl(input.relayUrl);
      if (!relayUrl) return yield* new RelayHostError({ reason: "invalid_relay_url" });
      const next = { relayUrl, deviceId: input.deviceId, token: input.token };
      // The shell sends the credential on every start; an unchanged one keeps the live connection.
      if (
        engine !== null &&
        credential?.relayUrl === next.relayUrl &&
        credential.deviceId === next.deviceId &&
        credential.token === next.token &&
        connection?.status !== "unauthorized"
      ) {
        return yield* status();
      }
      yield* secrets.set(CREDENTIAL_SECRET, encodeJson(next)).pipe(Effect.mapError(storageError));
      credential = next;
      startEngine();
      return yield* status();
    },
  );

  const clearCredential: RelayHost["Service"]["clearCredential"] = Effect.fn(
    "RelayHost.clearCredential",
  )(function* () {
    yield* secrets.remove(CREDENTIAL_SECRET).pipe(Effect.mapError(storageError));
    credential = null;
    offer = null;
    stopEngine();
    return yield* status();
  });

  const createOffer: RelayHost["Service"]["createOffer"] = Effect.fn("RelayHost.createOffer")(
    function* () {
      if (!credential || connection?.status !== "online")
        return yield* new RelayHostError({ reason: "not_online" });
      const expiresAt = DateTime.formatIso(DateTime.addDuration(yield* DateTime.now, OFFER_TTL));
      const secret = toBase64Url(new Uint8Array(NodeCrypto.randomBytes(24)));
      const view = {
        link: formatRelayPairingLink({
          relayUrl: credential.relayUrl,
          hostDeviceId: connection.deviceId,
          hostKey,
          secret,
          hostName: NodeOS.hostname().replace(/\.local$/i, ""),
        }),
        expiresAt,
      };
      offer = { secret, view };
      return view;
    },
  );

  const decide: RelayHost["Service"]["decide"] = Effect.fn("RelayHost.decide")(function* (input) {
    const approval = pending.get(input.id);
    if (!approval) return yield* new RelayHostError({ reason: "not_found" });
    if (!input.approve) {
      approval.settle({ kind: "reject", reason: "rejected" });
      return yield* status();
    }
    const issued = yield* issuePairingToken(approval.view.name).pipe(Effect.mapError(storageError));
    yield* saveDevices([
      ...devices.filter((device) => device.key !== approval.key),
      {
        key: approval.key,
        name: approval.view.name,
        approvedAt: DateTime.formatIso(yield* DateTime.now),
      },
    ]);
    approval.settle(ready(issued.credential));
    return yield* status();
  });

  const revokeDevice: RelayHost["Service"]["revokeDevice"] = Effect.fn("RelayHost.revokeDevice")(
    function* (input) {
      const device = devices.find((candidate) => candidate.key === input.key);
      if (!device) return yield* new RelayHostError({ reason: "not_found" });
      // Without an approved key the phone's session is unreachable: its only route is this tunnel.
      yield* saveDevices(devices.filter((candidate) => candidate.key !== input.key));
      engine?.disconnectClient(device.key);
      return yield* status();
    },
  );

  return RelayHost.of({
    status,
    setCredential,
    clearCredential,
    createOffer,
    decide,
    revokeDevice,
  });
});

export const layer = Layer.effect(RelayHost, make);
