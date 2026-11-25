// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalRandom:off -- The tunnel client is plain socket code outside the Effect runtime, like the relay host, and the relay's computer list is one plain request that cannot use the HttpClient this module wraps.
import * as NodeCrypto from "node:crypto";

import type { AuthMcpClientAccess } from "@t3tools/contracts";
import {
  type NoiseKeyPair,
  noiseKeyPairFromSecret,
  relaySafetyCode,
} from "@t3tools/shared/relayNoise";
import { toBase64Url } from "@t3tools/shared/relayTunnel";
import {
  type RelayTunnelClientOptions,
  RelayTunnelClient,
  RelayTunnelClientError,
  RelayTunnelPool,
  relayHostFromUrl,
} from "@t3tools/shared/relayTunnelClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readCloudCredential } from "./RelayHost.ts";

/**
 * This server as a client of the account's other computers over the Gustaf relay, signed in with
 * the credential it already holds as a host. A link's address is the tunnel's made-up origin, so
 * every HTTP call to a peer goes through `layerHttpClient` and nothing else needs to know.
 */

const PEER_KEY_SECRET = "relay-peer-key";
const PEER_HOSTS_SECRET = "relay-peer-hosts";
const MACHINES_TIMEOUT_MS = 10_000;

export interface RelayMachine {
  readonly deviceId: string;
  readonly name: string;
  readonly online: boolean;
}

export interface RelayMachinesResult {
  readonly machines: ReadonlyArray<RelayMachine>;
  readonly problem?: "signed_out" | "unavailable";
}

/** Why a relay link could not be started or finished, in the tunnel's own terms. */
export class RelayPeerLinkError extends Schema.TaggedError<RelayPeerLinkError>()(
  "RelayPeerLinkError",
  {
    reason: Schema.Literals([
      "relay_unreachable",
      "unauthorized",
      "host_offline",
      "rejected",
      "limit",
      "unknown_device",
      "linking_off",
      "busy",
      "policy",
      "handshake_failed",
      "closed",
      "signed_out",
      "no_code",
    ]),
    message: Schema.String,
  },
) {}

export interface RelayLinkRequest {
  readonly deviceId: string;
  readonly access: AuthMcpClientAccess;
  /** What the other computer's user sees the request come from. */
  readonly name: string;
  /** Called with the code both screens must show, once the computer asks its user. */
  readonly onSafetyCode: (code: string) => void;
}

export class RelayPeerTransport extends Context.Service<
  RelayPeerTransport,
  {
    /** `base`, except that tunnel origins go to that computer. */
    readonly wrapFetch: (base: typeof globalThis.fetch) => typeof globalThis.fetch;
    /** This computer's own relay device id, when it is signed in to the relay. */
    readonly selfDeviceId: Effect.Effect<Option.Option<string>>;
    /** The account's other computers and which hold a relay connection now. */
    readonly machines: Effect.Effect<RelayMachinesResult>;
    /**
     * Asks `deviceId`'s user to let this computer link there. Resolves with the one-time pairing
     * code for the link once they allow it, and from then on this computer reaches that one
     * only with the key it presented now.
     */
    readonly requestLink: (
      request: RelayLinkRequest,
    ) => Effect.Effect<{ readonly pairingCode: string }, RelayPeerLinkError>;
    /** Drops the tunnel and the key kept for `deviceId`, once nothing links there any more. */
    readonly forget: (deviceId: string) => Effect.Effect<void>;
  }
>()("t3/relay/RelayPeerTransport") {}

/** A tunnel failure in a failed request's cause chain: what the relay or the computer said. */
export const relayTunnelFailure = (error: unknown): RelayTunnelClientError | undefined => {
  let current = error;
  for (let depth = 0; depth < 6 && Predicate.isObject(current); depth++) {
    if (current instanceof RelayTunnelClientError) return current;
    current = Predicate.hasProperty(current, "cause") ? current.cause : undefined;
  }
  return undefined;
};

/** What a user can do about a failed tunnel, in a sentence naming the machine. */
export const relayFailureMessage = (error: RelayTunnelClientError, machine: string): string => {
  switch (error.reason) {
    case "host_offline":
      return `${machine} is not connected to the Gustaf relay. Check that Gustaf is running there and signed in (gustaf relay login).`;
    case "unauthorized":
      return "This computer is not signed in to the Gustaf relay, or its sign-in no longer works. Run gustaf relay login, or sign in again under Account.";
    case "limit":
      return "The Gustaf relay limit for your account is reached: too many open connections, or this month's traffic is used up.";
    case "handshake_failed":
      return `${machine} did not answer with the key this computer linked it with. Link it again if it was reinstalled.`;
    case "relay_unreachable":
      return "The Gustaf relay did not answer.";
    case "rejected":
      return `${machine} did not allow the link: it was declined there, or nobody answered in time.`;
    case "policy":
      return `${machine}'s managed policy does not allow that access.`;
    case "busy":
      return `${machine} already has link requests waiting. Answer them there, then try again.`;
    case "linking_off":
      return `Linked environments is off on ${machine}. Turn it on in its Settings → Labs.`;
    case "unknown_device":
      return `${machine} does not know this computer. It may run a Gustaf version from before relay links, or this computer was removed under its Gustaf relay devices there. Update it, then link again.`;
    case "closed":
      return `The connection to ${machine} through the Gustaf relay closed.`;
  }
};

const randomBytes = (length: number) => new Uint8Array(NodeCrypto.randomBytes(length));

/** The account's other computers as the relay lists them for this computer's own credential. */
async function listComputers(credential: {
  readonly relayUrl: string;
  readonly token: string;
  readonly deviceId: string;
}): Promise<RelayMachinesResult> {
  const response = await fetch(new URL("/v1/relay/hosts", credential.relayUrl), {
    headers: { accept: "application/json", authorization: `Bearer ${credential.token}` },
    signal: AbortSignal.timeout(MACHINES_TIMEOUT_MS),
  });
  if (response.status === 401) return { machines: [], problem: "signed_out" };
  if (!response.ok) return { machines: [], problem: "unavailable" };
  const body = (await response.json()) as {
    readonly online?: ReadonlyArray<unknown>;
    readonly computers?: ReadonlyArray<{
      readonly id?: unknown;
      readonly name?: unknown;
      readonly online?: unknown;
    }>;
  };
  const online = new Set((body.online ?? []).filter((id): id is string => typeof id === "string"));
  // An API from before names were listed only knows which computers are online.
  const listed =
    body.computers?.flatMap((computer) =>
      typeof computer.id === "string"
        ? [
            {
              deviceId: computer.id,
              name:
                typeof computer.name === "string" && computer.name.trim() !== ""
                  ? computer.name.trim().slice(0, 100)
                  : `Computer ${computer.id.slice(0, 8)}`,
              online: computer.online === true || online.has(computer.id),
            },
          ]
        : [],
    ) ??
    [...online].map((id) => ({ deviceId: id, name: `Computer ${id.slice(0, 8)}`, online: true }));
  return { machines: listed.filter((machine) => machine.deviceId !== credential.deviceId) };
}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const clientKeyPair: NoiseKeyPair = noiseKeyPairFromSecret(
    yield* secrets.getOrCreateRandom(PEER_KEY_SECRET, 32).pipe(Effect.orDie),
  );

  const readHosts = secrets.get(PEER_HOSTS_SECRET).pipe(
    Effect.map((stored) =>
      Option.match(stored, {
        onNone: () => ({}) as Record<string, { readonly hostKey: string }>,
        onSome: (bytes) => {
          try {
            return JSON.parse(new TextDecoder().decode(bytes)) as Record<
              string,
              { readonly hostKey: string }
            >;
          } catch {
            return {};
          }
        },
      }),
    ),
    Effect.orElseSucceed(() => ({}) as Record<string, { readonly hostKey: string }>),
  );
  const writeHosts = (hosts: Record<string, { readonly hostKey: string }>) =>
    secrets.set(PEER_HOSTS_SECRET, new TextEncoder().encode(JSON.stringify(hosts)));

  const credential = readCloudCredential(secrets);

  const pool = new RelayTunnelPool(async (hostDeviceId): Promise<RelayTunnelClientOptions> => {
    const signedIn = Option.getOrNull(await run(credential));
    if (signedIn === null) {
      throw new RelayTunnelClientError(
        "unauthorized",
        "This computer is not signed in to the Gustaf relay.",
      );
    }
    const pinned = (await run(readHosts))[hostDeviceId];
    if (pinned === undefined) {
      throw new RelayTunnelClientError(
        "unauthorized",
        "This computer is not linked to that machine over the relay.",
      );
    }
    return {
      relayUrl: signedIn.relayUrl,
      deviceToken: signedIn.token,
      hostDeviceId,
      hostKey: pinned.hostKey,
      clientKeyPair,
      // A known device is let in by its key alone; the host never reads this name again.
      name: "Gustaf server",
      randomBytes,
      streamResponses: true,
    };
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => pool.closeAll()));

  const machines: RelayPeerTransport["Service"]["machines"] = Effect.gen(function* () {
    const signedIn = yield* credential;
    if (Option.isNone(signedIn)) return { machines: [], problem: "signed_out" } as const;
    return yield* Effect.tryPromise({
      try: () => listComputers(signedIn.value),
      catch: () => ({ machines: [], problem: "unavailable" }) as RelayMachinesResult,
    }).pipe(Effect.catch((result) => Effect.succeed(result)));
  });

  const requestLink: RelayPeerTransport["Service"]["requestLink"] = Effect.fn(
    "RelayPeerTransport.requestLink",
  )(function* (request) {
    const signedIn = yield* credential;
    if (Option.isNone(signedIn)) {
      return yield* new RelayPeerLinkError({
        reason: "signed_out",
        message:
          "This computer is not signed in to the Gustaf relay. Run gustaf relay login, or sign in under Account.",
      });
    }
    const { relayUrl, token } = signedIn.value;
    const client = yield* Effect.tryPromise({
      try: (signal) =>
        RelayTunnelClient.connect({
          relayUrl,
          deviceToken: token,
          hostDeviceId: request.deviceId,
          // First contact: the safety code the user compares on both screens is what vouches
          // for this key, since the relay is the only thing that could have swapped it.
          hostKey: null,
          clientKeyPair,
          name: request.name,
          peerLink: { access: request.access },
          randomBytes,
          streamResponses: true,
          signal,
          onPending: (hostKey) =>
            request.onSafetyCode(relaySafetyCode(clientKeyPair.publicKey, hostKey)),
        }),
      catch: (cause) =>
        cause instanceof RelayTunnelClientError
          ? new RelayPeerLinkError({
              reason: cause.reason,
              message: relayFailureMessage(cause, "That computer"),
            })
          : new RelayPeerLinkError({
              reason: "closed",
              message: "The connection through the Gustaf relay failed.",
            }),
    });
    const pairingCode = client.pairingToken;
    const hostKey = toBase64Url(client.remoteStaticKey);
    client.close();
    if (pairingCode === undefined) {
      return yield* new RelayPeerLinkError({
        reason: "no_code",
        message: "That computer did not send a link code. Update Gustaf there, then try again.",
      });
    }
    yield* readHosts.pipe(
      Effect.flatMap((hosts) => writeHosts({ ...hosts, [request.deviceId]: { hostKey } })),
      Effect.mapError(
        () =>
          new RelayPeerLinkError({
            reason: "closed",
            message: "Could not keep the key of that computer.",
          }),
      ),
    );
    // A tunnel opened earlier still holds the old key.
    pool.forget(request.deviceId);
    return { pairingCode };
  });

  const forget: RelayPeerTransport["Service"]["forget"] = Effect.fn("RelayPeerTransport.forget")(
    function* (deviceId) {
      pool.forget(deviceId);
      const hosts = yield* readHosts;
      if (hosts[deviceId] === undefined) return;
      const { [deviceId]: _removed, ...rest } = hosts;
      yield* writeHosts(rest);
    },
    (effect) => Effect.ignore(effect),
  );

  return RelayPeerTransport.of({
    wrapFetch: (base) => pool.wrapFetch(base),
    selfDeviceId: credential.pipe(Effect.map(Option.map((signedIn) => signedIn.deviceId))),
    machines,
    requestLink,
    forget,
  });
});

export const layer = Layer.effect(RelayPeerTransport, make);

/**
 * The HTTP client with tunnel origins routed through `RelayPeerTransport`, and every other URL as
 * `base` sends it. The peers' HTTP calls (descriptor, sign-in, `/mcp`, thread streams) use this.
 */
export const layerHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const base = yield* HttpClient.HttpClient;
    const transport = yield* RelayPeerTransport;
    // Over whatever `fetch` the caller runs with, so a test's or a host's own stays in charge.
    return HttpClient.transform(base, (response) =>
      Effect.flatMap(FetchHttpClient.Fetch, (ambient) =>
        Effect.provideService(response, FetchHttpClient.Fetch, transport.wrapFetch(ambient)),
      ),
    );
  }),
);

/** Whether `url` is a made-up tunnel origin, which only a computer signed in to the relay reaches. */
export const isRelayUrl = (url: string) => relayHostFromUrl(url) !== null;
