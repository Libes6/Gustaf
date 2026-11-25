// @effect-diagnostics nodeBuiltinImport:off -- The computer name comes from node:os, as in RelayHost.
import * as NodeOS from "node:os";

import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  ORCHESTRATION_PROTOCOL_VERSION,
  type RelayHostCredentialInput,
  RelayHostStatus,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { resolveAccountApiUrl, signInComputer } from "../relay/RelayAccount.ts";
import { clearCloudCredential, writeCloudCredential } from "../relay/RelayHost.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";
import { type DiscoveredPairTarget, discoverPairTarget, makePairServerConfig } from "./pair.ts";

export class RelayCliError extends Schema.TaggedError<RelayCliError>()("RelayCliError", {
  message: Schema.String,
}) {}

const CREDENTIAL_PATH = "/api/relay-host/credential";

/** The running server, if any: it must take the credential itself to connect without a restart. */
const findRunningServer = (baseDir: Option.Option<string>) =>
  discoverPairTarget(Option.getOrUndefined(baseDir)).pipe(
    Effect.asSome,
    Effect.catchTags({ NoRunningServerError: () => Effect.succeedNone }),
  );

/** A one-minute bearer session with relay scopes, revoked once the request is done. */
const withRelaySession = Effect.fn("relay.withRelaySession")(function* <A, E, R>(
  target: DiscoveredPairTarget,
  use: (token: string) => Effect.Effect<A, E, R>,
) {
  const serverProtocolVersion = target.descriptor.orchestrationProtocolVersion ?? 1;
  // Opening another protocol's auth database would migrate it; refuse like `pair`.
  if (serverProtocolVersion !== ORCHESTRATION_PROTOCOL_VERSION) {
    return yield* new RelayCliError({
      message: `The running Gustaf server (${target.descriptor.serverVersion}) is a different version. Run this command with the matching CLI.`,
    });
  }
  const config = yield* makePairServerConfig({ target, logLevel: "Error" });
  return yield* Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    return yield* Effect.acquireUseRelease(
      auth.issueSession({
        ttl: Duration.minutes(1),
        scopes: [AuthRelayReadScope, AuthRelayWriteScope],
        label: "gustaf relay",
      }),
      (session) => use(session.token),
      (session) => auth.revokeSession(session.sessionId).pipe(Effect.ignore),
    );
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

const sendToServer = Effect.fn("relay.sendToServer")(
  function* (origin: string, token: string, credential: RelayHostCredentialInput | null) {
    const client = yield* HttpClient.HttpClient;
    const url = new URL(CREDENTIAL_PATH, origin).toString();
    const request = credential
      ? HttpClientRequest.put(url).pipe(HttpClientRequest.bodyJsonUnsafe(credential))
      : HttpClientRequest.delete(url);
    const response = yield* client.execute(HttpClientRequest.bearerToken(request, token));
    if (response.status < 200 || response.status >= 300) {
      return yield* new RelayCliError({
        message: `The running Gustaf server refused the relay settings (HTTP ${response.status}).`,
      });
    }
  },
  Effect.catchTags({
    HttpClientError: () =>
      Effect.fail(new RelayCliError({ message: "Cannot reach the running Gustaf server." })),
  }),
);

const withSecrets = Effect.fn("relay.withSecrets")(function* <A, E, R>(
  baseDir: Option.Option<string>,
  use: (secrets: ServerSecretStore.ServerSecretStore["Service"]) => Effect.Effect<A, E, R>,
) {
  const config = yield* resolveCliAuthConfig({ baseDir }, Option.none(), { quietLogs: true });
  return yield* Effect.gen(function* () {
    return yield* use(yield* ServerSecretStore.ServerSecretStore);
  }).pipe(Effect.provide(ServerSecretStore.layer.pipe(Layer.provide(ServerConfig.layer(config)))));
});

/**
 * Hands the credential to the running server, or stores it for the next start. `null` signs the
 * computer out of the relay. Returns whether a running server took it.
 */
export const storeRelayCredential = Effect.fn("relay.storeRelayCredential")(function* (
  baseDir: Option.Option<string>,
  credential: RelayHostCredentialInput | null,
) {
  const running = yield* findRunningServer(baseDir);
  if (Option.isSome(running)) {
    const target = running.value;
    yield* withRelaySession(target, (token) =>
      sendToServer(target.state.origin, token, credential),
    );
    return true;
  }
  yield* withSecrets(baseDir, (secrets) =>
    credential ? writeCloudCredential(secrets, credential) : clearCloudCredential(secrets),
  ).pipe(Effect.mapError((error) => new RelayCliError({ message: error.message })));
  return false;
});

const computerName = () =>
  NodeOS.hostname()
    .replace(/\.local$/i, "")
    .slice(0, 100) || "Gustaf computer";

const loginCommand = Command.make("login", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Sign this computer in to your Gustaf account so your phone and other computers can reach it through the Gustaf relay.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const apiUrl = resolveAccountApiUrl(
        Option.getOrUndefined(yield* Config.String("GUSTAF_API_URL").pipe(Config.option)),
      );
      const launcher = yield* ExternalLauncher.ExternalLauncher;
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const credential = yield* Effect.tryPromise({
        try: () =>
          signInComputer({
            apiUrl,
            computerName: computerName(),
            openUrl: (url) =>
              void runFork(
                Console.log(
                  [
                    "Sign in to your Gustaf account in the browser:",
                    `  ${url}`,
                    "",
                    "The browser must run on this computer. Over SSH, forward the port in the address above first.",
                  ].join("\n"),
                ).pipe(Effect.andThen(launcher.launchBrowser(url)), Effect.ignore),
              ),
          }),
        catch: (cause) =>
          new RelayCliError({ message: cause instanceof Error ? cause.message : String(cause) }),
      });
      const running = yield* storeRelayCredential(flags.baseDir, credential);
      yield* Console.log(
        [
          "",
          "This computer is signed in to the Gustaf relay.",
          running
            ? "The running server is connecting now."
            : "It connects the next time the Gustaf server starts.",
          "To pair a device, open Settings → Sharing & access in Gustaf on this computer and use the relay QR code or link.",
        ].join("\n"),
      );
    }).pipe(Effect.provide(Layer.mergeAll(FetchHttpClient.layer, ExternalLauncher.layer))),
  ),
);

const logoutCommand = Command.make("logout", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "Disconnect this computer from the Gustaf relay and forget its credential.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* storeRelayCredential(flags.baseDir, null);
      yield* Console.log(
        "This computer no longer uses the Gustaf relay. It stays listed under your account's devices until you remove it there.",
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const STATUS_PATH = "/api/relay-host";
const DECISION_PATH = "/api/relay-host/decision";

/** The running server's relay state, or the state after answering one request (`decision`). */
const talkToServer = Effect.fn("relay.talkToServer")(
  function* (baseDir: Option.Option<string>, decision: { id: string; approve: boolean } | null) {
    const running = yield* findRunningServer(baseDir);
    if (Option.isNone(running)) {
      return yield* new RelayCliError({ message: "No Gustaf server is running on this computer." });
    }
    const target = running.value;
    return yield* withRelaySession(target, (token) =>
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const url = new URL(decision === null ? STATUS_PATH : DECISION_PATH, target.state.origin);
        const request =
          decision === null
            ? HttpClientRequest.get(url.toString())
            : HttpClientRequest.post(url.toString()).pipe(
                HttpClientRequest.bodyJsonUnsafe(decision),
              );
        const response = yield* client.execute(HttpClientRequest.bearerToken(request, token));
        if (response.status < 200 || response.status >= 300) {
          return yield* new RelayCliError({
            message:
              response.status === 404
                ? "No such request. List them with gustaf relay requests."
                : `The running Gustaf server refused it (HTTP ${response.status}).`,
          });
        }
        return yield* HttpClientResponse.schemaBodyJson(RelayHostStatus)(response);
      }),
    );
  },
  Effect.catchTags({
    HttpClientError: () =>
      Effect.fail(new RelayCliError({ message: "Cannot reach the running Gustaf server." })),
    SchemaError: () =>
      Effect.fail(
        new RelayCliError({ message: "The running Gustaf server answered in an unknown format." }),
      ),
  }),
);

/** The request an `<id>` names: exactly, or by the start of its id when only one starts that way. */
const pickRelayRequest = Effect.fn("relay.pickRelayRequest")(function* <
  T extends { readonly id: string },
>(pending: ReadonlyArray<T>, wanted: string) {
  const exact = pending.filter((request) => request.id === wanted);
  const matches =
    exact.length > 0
      ? exact
      : wanted.length >= 4
        ? pending.filter((request) => request.id.startsWith(wanted))
        : [];
  const [only, ...others] = matches;
  if (only !== undefined && others.length === 0) return only;
  return yield* new RelayCliError({
    message:
      pending.length === 0
        ? "Nothing is waiting for an answer."
        : "No single request has that id. List them with gustaf relay requests.",
  });
});

const requestsCommand = Command.make("requests", { baseDir: baseDirFlag }).pipe(
  Command.withDescription(
    "List the devices and computers waiting for this computer's user to allow them, with the safety code each shows. For a computer with no screen to click Allow on.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const status = yield* talkToServer(flags.baseDir, null);
      yield* Console.log(
        status.pending.length === 0
          ? "Nothing is waiting for an answer.\n"
          : `${status.pending
              .map(
                (request) =>
                  `${request.id}  ${request.name}  ${
                    request.peerLink === undefined
                      ? "wants to connect"
                      : `wants to link its agents here (${request.peerLink.access})`
                  }  safety code ${request.safetyCode}`,
              )
              .join(
                "\n",
              )}\n\nAllow one with: gustaf relay allow <id>. Only if the code matches the one shown on that device.\n`,
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);

const answerCommand = (name: "allow" | "deny", approve: boolean) =>
  Command.make(name, {
    baseDir: baseDirFlag,
    id: Argument.String("id").pipe(
      Argument.withDescription(
        "The request's id, or the start of it, from `gustaf relay requests`.",
      ),
    ),
  }).pipe(
    Command.withDescription(
      approve
        ? "Allow a device or computer that is waiting. Check first that its safety code matches the one it shows."
        : "Turn away a device or computer that is waiting.",
    ),
    Command.withHandler((flags) =>
      Effect.gen(function* () {
        const status = yield* talkToServer(flags.baseDir, null);
        const request = yield* pickRelayRequest(status.pending, flags.id);
        yield* talkToServer(flags.baseDir, { id: request.id, approve });
        yield* Console.log(`${approve ? "Allowed" : "Turned away"} ${request.name}.\n`);
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    ),
  );

export const relayCommand = Command.make("relay").pipe(
  Command.withDescription("Connect this computer to the Gustaf relay without the desktop app."),
  Command.withSubcommands([
    loginCommand,
    logoutCommand,
    requestsCommand,
    answerCommand("allow", true),
    answerCommand("deny", false),
  ]),
);
