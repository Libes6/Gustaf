// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The relay engine runs outside the Effect runtime; a pending approval is a Promise it awaits.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  AuthMcpClientAccess,
  type RelayHostCredentialInput,
  type RelayHostDevice,
  type RelayHostPairingOffer,
  type RelayHostPendingDevice,
  type RelayHostStatus,
} from "@t3tools/contracts";
import { bytesEqual, noiseKeyPairFromSecret, relaySafetyCode } from "@t3tools/shared/relayNoise";
import {
  type RelayClientHello,
  formatRelayPairingLink,
  fromBase64Url,
  toBase64Url,
} from "@t3tools/shared/relayTunnel";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type RelayAdmission,
  type RelayHostConnectionState,
  RelayHostEngine,
} from "./RelayHostEngine.ts";

export class RelayHostError extends Schema.TaggedError<RelayHostError>()("RelayHostError", {
  reason: Schema.Literals(["not_online", "not_found", "invalid_relay_url", "storage", "policy"]),
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
      case "policy":
        return "This computer's managed policy does not allow that access.";
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
    readonly setTrust: (input: {
      readonly enabled: boolean;
    }) => Effect.Effect<RelayHostStatus, RelayHostError>;
  }
>()("t3/relay/RelayHost") {}

const HOST_KEY_SECRET = "relay-host-key";
const CREDENTIAL_SECRET = "relay-host-credential";
const DEVICES_SECRET = "relay-host-devices";
const TRUST_SECRET = "relay-host-trust";
const OFFER_TTL = Duration.minutes(5);
const APPROVAL_TTL_MS = 5 * 60_000;
// Requests to link or to pair come from any device of the account, so only a few may wait at once.
const MAX_PENDING_PEER_LINKS = 3;
const MAX_PENDING_ACCOUNT_PAIRINGS = 3;
// A phone that reconnects often does not rewrite the device list each time.
const LAST_SEEN_WRITE_INTERVAL_MS = 10 * 60_000;
// How many characters of a device's key its sessions' labels carry, to tell them apart by name.
const LABEL_KEY_LENGTH = 12;
const isLinkAccess = Schema.is(AuthMcpClientAccess);
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
  /** The first time this computer's user allowed the key. */
  approvedAt: Schema.String,
  lastSeenAt: Schema.optional(Schema.String),
  /**
   * The user allowed this key as a client (a phone or another desktop app) once, by hand: the
   * only kind of approval "Trust my other devices" repeats. Devices stored before this stay
   * unmarked until the user allows them again.
   */
  client: Schema.optional(Schema.Boolean),
});
type StoredDevice = typeof StoredDevice.Type;
const StoredDevices = Schema.Array(StoredDevice);

const StoredTrust = Schema.Struct({ enabled: Schema.Boolean });
const decodeStoredTrust = Schema.decodeUnknownOption(StoredTrust);

/** What a pending request asks for beyond a QR scan. */
type RequestKind =
  | { readonly peerLink: NonNullable<RelayHostPendingDevice["peerLink"]> }
  | { readonly viaAccount: true };

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

/** For `gustaf relay login` while no server runs; a running one takes it through `setCredential`. */
export const writeCloudCredential = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  input: RelayHostCredentialInput,
) => {
  const relayUrl = readRelayUrl(input.relayUrl);
  if (!relayUrl) return Effect.fail(new RelayHostError({ reason: "invalid_relay_url" }));
  return secrets
    .set(CREDENTIAL_SECRET, encodeJson({ relayUrl, deviceId: input.deviceId, token: input.token }))
    .pipe(Effect.mapError((cause) => new RelayHostError({ reason: "storage", cause })));
};

export const clearCloudCredential = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  secrets
    .remove(CREDENTIAL_SECRET)
    .pipe(Effect.mapError((cause) => new RelayHostError({ reason: "storage", cause })));

function readRelayUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const TRUSTED_SESSION_SUFFIX = " · trusted)";

/**
 * Names a session this computer issues to a relay device. It ends with the key's first characters
 * (and a marker when no one was asked), and a device's name cannot forge that ending, so revoking
 * finds exactly the sessions of one key.
 */
const sessionLabel = (name: string, key: string, byTrust: boolean) =>
  `${name} (relay ${key.slice(0, LABEL_KEY_LENGTH)}${byTrust ? TRUSTED_SESSION_SUFFIX : ")"}`;

const ownsSession = (label: string, key: string) =>
  label.endsWith(` (relay ${key.slice(0, LABEL_KEY_LENGTH)})`) ||
  label.endsWith(` (relay ${key.slice(0, LABEL_KEY_LENGTH)}${TRUSTED_SESSION_SUFFIX}`);

const isTrustedSession = (label: string) =>
  label.endsWith(TRUSTED_SESSION_SUFFIX) && label.includes(" (relay ");

/** The host may be bound to every interface; tunneled requests always come from this machine. */
function localOrigin(host: string | undefined, port: number) {
  const address =
    host === undefined || host === "" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `http://${address.includes(":") && !address.startsWith("[") ? `[${address}]` : address}:${port}`;
}

const make = Effect.fn("RelayHost.make")(function* (
  options: { readonly localOrigin?: string; readonly approvalTtlMs?: number | undefined } = {},
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const config = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const linkedEnvironmentsEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );
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
  let trusting = yield* readText(TRUST_SECRET).pipe(
    Effect.map(Option.flatMap((text) => decodeStoredTrust(parseJson(text)))),
    Effect.map(Option.exists((stored) => stored.enabled)),
    Effect.orElseSucceed(() => false),
  );
  let connection: RelayHostConnectionState | null = null;
  let engine: RelayHostEngine | null = null;
  let offer: { secret: string; view: RelayHostPairingOffer } | null = null;
  const pending = new Map<string, PendingApproval>();

  const storageError = (cause: unknown) => new RelayHostError({ reason: "storage", cause });
  const devicesLock = yield* Semaphore.make(1);
  /** Changes the device list from its latest state: approvals, revocations and last-seen writes never undo each other. */
  const updateDevices = (
    change: (current: ReadonlyArray<StoredDevice>) => ReadonlyArray<StoredDevice>,
  ) =>
    devicesLock.withPermits(1)(
      Effect.suspend(() => {
        const next = change(devices);
        return secrets.set(DEVICES_SECRET, encodeJson(next)).pipe(
          Effect.mapError(storageError),
          Effect.tap(() =>
            Effect.sync(() => {
              devices = next;
            }),
          ),
        );
      }),
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
          ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: device.lastSeenAt }),
          trusted: device.client === true,
        })),
        pending: [...pending.values()].map((approval) => approval.view),
        ...(offer ? { offer: offer.view } : {}),
        trustOtherDevices: trusting,
      };
    });

  // The phone pairs through the tunnel like over any other route and gets an ordinary session. Its
  // label ends with a piece of the device's key, which is how revoking finds the sessions again.
  const issuePairingToken = (name: string, key: string, byTrust: boolean) =>
    auth.createPairingLink({ ttl: PAIRING_TOKEN_TTL, label: sessionLabel(name, key, byTrust) });

  const ready = (pairingToken?: string): RelayAdmission =>
    pairingToken === undefined ? { kind: "ready" } : { kind: "ready", pairingToken };
  const reject = (reason: string): RelayAdmission => ({ kind: "reject", reason });

  const waitForUser = (
    key: string,
    name: string,
    closed: Promise<void>,
    kind?: RequestKind,
  ): RelayAdmission => {
    const id = NodeCrypto.randomUUID();
    const decision = new Promise<RelayAdmission>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(reject("rejected"));
      }, options.approvalTtlMs ?? APPROVAL_TTL_MS);
      pending.set(id, {
        key,
        view: {
          id,
          name,
          requestedAt: new Date().toISOString(),
          safetyCode: safetyCode(key),
          ...kind,
        },
        settle: (admission) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(admission);
        },
      });
      // The device gave up (closed its request, lost the relay): nobody is left to allow.
      void closed.then(() => pending.get(id)?.settle(reject("rejected")));
    });
    return { kind: "pending", decision };
  };

  /**
   * A device of the same account asks to link or to pair without a QR code. The account proves
   * nothing about who is asking, so only a few requests wait at once, one per key, and each one
   * waits for this computer's user. Anything else is turned away with `busy`.
   */
  const requestApproval = (
    client: {
      readonly clientKey: string;
      readonly hello: { readonly name: string };
      readonly closed: Promise<void>;
    },
    kind: RequestKind,
  ): RelayAdmission => {
    const sameKind = (approval: PendingApproval) =>
      "peerLink" in kind ? approval.view.peerLink !== undefined : approval.view.viaAccount === true;
    const waiting = [...pending.values()].filter(sameKind);
    const cap = "peerLink" in kind ? MAX_PENDING_PEER_LINKS : MAX_PENDING_ACCOUNT_PAIRINGS;
    if (waiting.length >= cap || waiting.some((approval) => approval.key === client.clientKey)) {
      return reject("busy");
    }
    return waitForUser(client.clientKey, client.hello.name, client.closed, kind);
  };

  /**
   * A machine of the same account asks to link its agents here. This always waits for the user,
   * and "Trust my other devices" does not change that: a link hands an agent standing access, and
   * the requester takes this key on trust and relies on the user comparing safety codes.
   */
  const admitPeerLink = Effect.fn("RelayHost.admitPeerLink")(function* (
    client: {
      readonly clientKey: string;
      readonly hello: { readonly name: string };
      readonly closed: Promise<void>;
    },
    access: string,
  ) {
    if (!isLinkAccess(access)) return reject("rejected");
    if (!(yield* linkedEnvironmentsEnabled)) return reject("linking_off");
    return requestApproval(client, { peerLink: { access } });
  });

  /**
   * A device of the account asks to pair as a client from its computer list. The user answers
   * with the safety code in front of them, unless they turned on "Trust my other devices" and this
   * key is one they already allowed as a client: then it gets the same pairing, with nothing more
   * and no prompt. A new key always waits, so an account's token alone never adds a device.
   */
  const admitAccountPairing = Effect.fn("RelayHost.admitAccountPairing")(function* (client: {
    readonly clientKey: string;
    readonly hello: { readonly name: string };
    readonly closed: Promise<void>;
  }) {
    const device = devices.find((candidate) => candidate.key === client.clientKey);
    if (trusting && device?.client === true) {
      const issued = yield* issuePairingToken(client.hello.name, client.clientKey, true).pipe(
        Effect.map((link) => ready(link.credential)),
        Effect.catch((error) =>
          Effect.succeed(
            error._tag === "ManagedPolicyRefusedError" ? reject("policy") : reject("rejected"),
          ),
        ),
      );
      return issued;
    }
    return requestApproval(client, { viaAccount: true });
  });

  const noteSeen = (key: string, nowMs: number) =>
    Effect.suspend(() => {
      const device = devices.find((candidate) => candidate.key === key);
      if (device === undefined) return Effect.void;
      const last = device.lastSeenAt === undefined ? 0 : Date.parse(device.lastSeenAt);
      if (nowMs - last < LAST_SEEN_WRITE_INTERVAL_MS) return Effect.void;
      const seen = new Date(nowMs).toISOString();
      return updateDevices((current) =>
        current.map((candidate) =>
          candidate.key === key ? { ...candidate, lastSeenAt: seen } : candidate,
        ),
      ).pipe(Effect.ignore);
    });

  /** Runs inside the engine's callback: decides about a client whose handshake completed. */
  const admit = Effect.fn("RelayHost.admit")(function* (client: {
    readonly clientKey: string;
    readonly hello: RelayClientHello;
    readonly closed: Promise<void>;
  }) {
    const now = yield* Clock.currentTimeMillis;
    const known = devices.some((device) => device.key === client.clientKey);
    yield* noteSeen(client.clientKey, now);
    const secret = client.hello.pairingSecret;
    const current = offer;
    const scanned =
      secret !== undefined &&
      current !== null &&
      Date.parse(current.view.expiresAt) > now &&
      bytesEqual(new TextEncoder().encode(secret), new TextEncoder().encode(current.secret));
    if (!scanned) {
      const requested = client.hello.peerLink;
      if (requested !== undefined) return yield* admitPeerLink(client, requested.access);
      if (client.hello.accountPairing === true) return yield* admitAccountPairing(client);
      return known ? ready() : reject("unknown_device");
    }
    // One scan, one device: a second phone needs a fresh code.
    offer = null;
    // An allowed phone that scans again (say, after removing the computer) needs no new approval.
    if (known) {
      return ready(
        (yield* issuePairingToken(client.hello.name, client.clientKey, false)).credential,
      );
    }
    return waitForUser(client.clientKey, client.hello.name, client.closed);
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
      localOrigin: options.localOrigin ?? localOrigin(config.host, config.port),
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

  /** A refused or failed issue ends the request with the reason the device can act on. */
  const failIssue = <A, E extends { readonly _tag: string }, R>(
    approval: PendingApproval,
    issuing: Effect.Effect<A, E, R>,
  ) =>
    issuing.pipe(
      Effect.mapError((error) =>
        error._tag === "ManagedPolicyRefusedError"
          ? new RelayHostError({ reason: "policy" })
          : storageError(error),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.reason === "policy") approval.settle(reject("policy"));
        }),
      ),
    );

  const decide: RelayHost["Service"]["decide"] = Effect.fn("RelayHost.decide")(function* (input) {
    const approval = pending.get(input.id);
    if (!approval) return yield* new RelayHostError({ reason: "not_found" });
    if (!input.approve) {
      approval.settle(reject("rejected"));
      return yield* status();
    }
    const linkAccess = approval.view.peerLink?.access;
    // A link's code carries the access the user is allowing, and this computer's policy may cap it.
    const issued = yield* failIssue(
      approval,
      linkAccess === undefined
        ? issuePairingToken(approval.view.name, approval.key, false)
        : auth.issuePairingCredential({
            access: linkAccess,
            purpose: "peer-link",
            label: `Link · ${approval.view.name} (relay)`,
          }),
    );
    const allowedAt = DateTime.formatIso(yield* DateTime.now);
    yield* updateDevices((current) => {
      const before = current.find((device) => device.key === approval.key);
      return [
        ...current.filter((device) => device.key !== approval.key),
        {
          key: approval.key,
          name: approval.view.name,
          approvedAt: before?.approvedAt ?? allowedAt,
          lastSeenAt: allowedAt,
          // Only a hand-allowed client can later skip the prompt; a link never does.
          ...(before?.client === true || linkAccess === undefined ? { client: true } : {}),
        },
      ];
    });
    approval.settle(ready(issued.credential));
    return yield* status();
  });

  /** Ends the sessions whose label `matches`, so a device cannot keep using them on another route. */
  const endSessions = (matches: (label: string) => boolean) =>
    auth.listSessions().pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions.filter(
            (session) => session.client.label !== undefined && matches(session.client.label),
          ),
          (session) => auth.revokeSession(session.sessionId),
          { discard: true },
        ),
      ),
      Effect.mapError(storageError),
    );

  const revokeDevice: RelayHost["Service"]["revokeDevice"] = Effect.fn("RelayHost.revokeDevice")(
    function* (input) {
      const device = devices.find((candidate) => candidate.key === input.key);
      if (!device) return yield* new RelayHostError({ reason: "not_found" });
      // The key goes first: nothing new gets in while the old sessions end.
      yield* updateDevices((current) => current.filter((candidate) => candidate.key !== input.key));
      for (const approval of pending.values()) {
        if (approval.key === device.key) approval.settle(reject("rejected"));
      }
      engine?.disconnectClient(device.key);
      // Sessions from before labels carried the key are `<name> (relay)`: ended too, at the risk
      // of another device that shares the name, which only has to pair again.
      yield* endSessions(
        (label) => ownsSession(label, device.key) || label === `${device.name} (relay)`,
      );
      return yield* status();
    },
  );

  const setTrust: RelayHost["Service"]["setTrust"] = Effect.fn("RelayHost.setTrust")(
    function* (input) {
      if (trusting === input.enabled) return yield* status();
      yield* secrets
        .set(TRUST_SECRET, encodeJson({ enabled: input.enabled }))
        .pipe(Effect.mapError(storageError));
      trusting = input.enabled;
      // Sessions nobody was asked about end now; the ones the user allowed by hand stay.
      if (!input.enabled) yield* endSessions(isTrustedSession);
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
    setTrust,
  });
});

export const layer = Layer.effect(RelayHost, make());

/**
 * `localOrigin` is where tunneled requests go; tests point it at a server on a random port, and
 * shorten how long a request waits for the user.
 */
export const layerWith = (options: {
  readonly localOrigin?: string;
  readonly approvalTtlMs?: number | undefined;
}) => Layer.effect(RelayHost, make(options));
