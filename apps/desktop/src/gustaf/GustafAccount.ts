// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off -- Loopback PKCE callback listener and OS computer-name detection run over Node built-ins.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";

import {
  type GustafAccountDevice,
  type GustafAccountState,
  GustafCloudUserSchema,
  type GustafRelayClientCredential,
  type GustafReportProblemInput,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Base64 from "effect/encoding/Base64";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as GustafCloudApi from "./GustafCloudApi.ts";
import { collectDiagnostics, redactText } from "./GustafDiagnostics.ts";

const ACCOUNT_FILE_NAME = "gustaf-account.encrypted.json";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL = Duration.hours(24);
const RELAY_HANDOFF_TIMEOUT = Duration.seconds(10);
const BACKEND_READY_TIMEOUT = Duration.seconds(60);
const REPORT_MESSAGE_CHARS = 5000;
const RELAY_CLIENT_VALUE_LIMIT = 64 * 1024;
const RELAY_CLIENT_KEYS = new Set(["gustaf.relay.phone-key", "gustaf.relay.hosts"]);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class GustafAccountError extends Schema.TaggedError<GustafAccountError>()(
  "GustafAccountError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const EncryptedAccountDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  encryptedAccount: Schema.String,
});

const StoredSessionSchema = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.String,
  user: GustafCloudUserSchema,
});

const StoredDeviceSchema = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  userId: Schema.String,
});

const StoredAccountSchema = Schema.Struct({
  session: Schema.NullOr(StoredSessionSchema),
  device: Schema.NullOr(StoredDeviceSchema),
  relayClient: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

interface StoredAccount {
  session: typeof StoredSessionSchema.Type | null;
  device: typeof StoredDeviceSchema.Type | null;
  relayClient: Record<string, string>;
}

const decodeEncryptedDocument = Schema.decodeEffect(
  fromLenientJson(EncryptedAccountDocumentSchema),
);
const encodeEncryptedDocument = Schema.encodeEffect(
  fromLenientJson(EncryptedAccountDocumentSchema),
);
const decodeStoredAccount = Schema.decodeEffect(Schema.fromJsonString(StoredAccountSchema));
const encodeStoredAccount = Schema.encodeEffect(Schema.fromJsonString(StoredAccountSchema));

const emptyStoredAccount = (): StoredAccount => ({
  session: null,
  device: null,
  relayClient: {},
});

const isEmptyStoredAccount = (account: StoredAccount): boolean =>
  account.session === null &&
  account.device === null &&
  Object.keys(account.relayClient).length === 0;

const toAccountState = (account: StoredAccount): GustafAccountState => ({
  signedIn: account.session !== null,
  user: account.session?.user ?? null,
  expiresAt: account.session?.expiresAt ?? null,
  deviceId: account.device?.id ?? null,
});

export function pkceCodeChallenge(verifier: string): string {
  return NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
}

export type CallbackResult =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied"; readonly error: string }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "other" };

export function parseCallback(target: string, expectedState: string): CallbackResult {
  if (!target.startsWith("/")) return { kind: "other" };
  let url: URL;
  try {
    url = new URL(target, "http://127.0.0.1");
  } catch {
    return { kind: "other" };
  }
  if (url.pathname !== "/callback") return { kind: "other" };
  if (url.searchParams.get("state") !== expectedState) return { kind: "state_mismatch" };
  const error = url.searchParams.get("error");
  if (error !== null) return { kind: "denied", error };
  const code = url.searchParams.get("code");
  return code ? { kind: "code", code } : { kind: "denied", error: "invalid_response" };
}

export function deniedMessage(error: string): string {
  if (error === "access_denied") return "Sign-in was cancelled in the browser.";
  return /^[A-Za-z0-9_]{1,64}$/.test(error) ? `Sign-in failed (${error}).` : "Sign-in failed.";
}

export function isDeviceId(id: string): boolean {
  return DEVICE_ID_PATTERN.test(id);
}

function readComputerName(platform: NodeJS.Platform): string {
  let rawName = "";
  if (platform === "darwin") {
    try {
      rawName = NodeChildProcess.execFileSync("scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2000,
      });
    } catch {
      rawName = "";
    }
  }
  if (rawName.trim().length === 0) {
    try {
      rawName = NodeOS.hostname();
    } catch {
      rawName = "";
    }
  }
  const normalized = Array.from(rawName.trim()).slice(0, 100).join("");
  return normalized.length > 0 ? normalized : "Gustaf computer";
}

const callbackPage = (title: string) =>
  `<!doctype html><meta charset=utf-8><title>Gustaf</title>` +
  `<body style="font:16px system-ui;margin:4rem;text-align:center">` +
  `<h1>${title}</h1><p>You can close this tab and return to Gustaf.</p>`;

function waitForBrowserCode(input: {
  readonly apiBase: string;
  readonly verifier: string;
  readonly state: string;
  readonly timeoutMs?: number;
  readonly openExternal: (url: string) => void;
  readonly registerCancel: (cancel: () => void) => void;
}): Effect.Effect<{ readonly code: string; readonly redirectUri: string }, GustafAccountError> {
  return Effect.callback<
    { readonly code: string; readonly redirectUri: string },
    GustafAccountError
  >((resume) => {
    let settled = false;
    let redirectUri = "";

    const finish = (
      outcome:
        | { readonly ok: true; readonly code: string }
        | { readonly ok: false; readonly detail: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      server.closeIdleConnections();
      if (outcome.ok) {
        resume(Effect.succeed({ code: outcome.code, redirectUri }));
      } else {
        resume(Effect.fail(new GustafAccountError({ detail: outcome.detail })));
      }
    };

    const server = NodeHttp.createServer((request, response) => {
      const callback: CallbackResult =
        request.method === "GET"
          ? parseCallback(request.url ?? "", input.state)
          : { kind: "other" };
      const answer = (status: number, body: string) => {
        response.writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          connection: "close",
        });
        response.end(body);
      };
      switch (callback.kind) {
        case "other":
          return answer(404, "");
        case "code":
          answer(200, callbackPage("Signed in"));
          return finish({ ok: true, code: callback.code });
        case "denied":
          answer(200, callbackPage("Sign-in did not finish"));
          return finish({ ok: false, detail: deniedMessage(callback.error) });
        case "state_mismatch":
          answer(400, callbackPage("Sign-in did not finish"));
          return finish({
            ok: false,
            detail: "Sign-in was rejected: the browser answered for another attempt.",
          });
      }
    });

    const timer = setTimeout(
      () => finish({ ok: false, detail: "Sign-in timed out. Try again." }),
      input.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    );

    input.registerCancel(() => finish({ ok: false, detail: "Sign-in was cancelled." }));

    server.on("error", (error) =>
      finish({ ok: false, detail: `Cannot listen for the sign-in answer: ${error.message}` }),
    );

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return finish({ ok: false, detail: "Cannot listen for the sign-in answer." });
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      const signInUrl = GustafCloudApi.buildSignInUrl({
        redirectUri,
        codeChallenge: pkceCodeChallenge(input.verifier),
        state: input.state,
        apiBase: input.apiBase,
      });
      input.openExternal(signInUrl);
    });

    return Effect.sync(() => finish({ ok: false, detail: "Sign-in was cancelled." }));
  });
}

export class GustafAccount extends Context.Service<
  GustafAccount,
  {
    readonly getState: Effect.Effect<GustafAccountState, GustafAccountError>;
    readonly signIn: Effect.Effect<GustafAccountState, GustafAccountError>;
    readonly cancelSignIn: Effect.Effect<void>;
    readonly signOut: Effect.Effect<GustafAccountState, GustafAccountError>;
    readonly listDevices: Effect.Effect<readonly GustafAccountDevice[], GustafAccountError>;
    readonly registerThisComputer: Effect.Effect<GustafAccountState, GustafAccountError>;
    readonly revokeDevice: (
      deviceId: string,
    ) => Effect.Effect<GustafAccountState, GustafAccountError>;
    readonly reportProblem: (
      input: GustafReportProblemInput,
    ) => Effect.Effect<void, GustafAccountError>;
    readonly getRelayClientCredential: Effect.Effect<
      GustafRelayClientCredential,
      GustafAccountError
    >;
    readonly getRelayClientStorageItem: (
      key: string,
    ) => Effect.Effect<string | null, GustafAccountError>;
    readonly setRelayClientStorageItem: (
      key: string,
      value: string,
    ) => Effect.Effect<void, GustafAccountError>;
    readonly getClientConfig: Effect.Effect<unknown, GustafAccountError>;
    readonly syncRelayCredentialToBackend: Effect.Effect<void>;
    readonly startBackgroundTasks: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/gustaf/GustafAccount") {}

export interface MakeGustafAccountOptions {
  readonly signInTimeoutMs?: number;
  readonly openExternal?: (url: string) => Effect.Effect<boolean>;
}

/** @public */
export const makeWithOptions = Effect.fn("gustaf.account.make")(function* (
  options?: MakeGustafAccountOptions,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const shell = yield* ElectronShell.ElectronShell;
  const windows = yield* ElectronWindow.ElectronWindow;
  const httpClient = yield* HttpClient.HttpClient;
  const backendPool = yield* DesktopBackendPool.DesktopBackendPool;
  const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const hostEnv = yield* HostProcess.Environment;

  const apiBase = GustafCloudApi.resolveGustafCloudApiBase(hostEnv.GUSTAF_API_URL);
  const accountPath = path.join(environment.stateDir, ACCOUNT_FILE_NAME);
  const fileSemaphore = yield* Semaphore.make(1);

  let signInAttempt = 0;
  let cancelActiveSignIn: (() => void) | null = null;

  const requireEncryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      () => new GustafAccountError({ detail: "System credential encryption is unavailable." }),
    ),
    Effect.flatMap((available) =>
      available
        ? Effect.void
        : Effect.fail(
            new GustafAccountError({ detail: "System credential encryption is unavailable." }),
          ),
    ),
  );

  const loadUnlocked = Effect.gen(function* () {
    const raw = yield* fileSystem
      .readFileString(accountPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<string | null>(null)
            : Effect.fail(
                new GustafAccountError({ detail: "Cannot read the saved Gustaf account." }),
              ),
        ),
      );
    if (raw === null) return emptyStoredAccount();

    const doc = yield* decodeEncryptedDocument(raw).pipe(
      Effect.mapError(() => new GustafAccountError({ detail: "Saved account is unreadable." })),
    );
    yield* requireEncryptionAvailable;
    const bytes = yield* Effect.fromResult(Base64.decode(doc.encryptedAccount)).pipe(
      Effect.mapError(() => new GustafAccountError({ detail: "Saved account is unreadable." })),
    );
    const plaintext = yield* safeStorage
      .decryptString(bytes)
      .pipe(
        Effect.mapError(() => new GustafAccountError({ detail: "Saved account is unreadable." })),
      );
    const parsed = yield* decodeStoredAccount(plaintext).pipe(
      Effect.mapError(() => new GustafAccountError({ detail: "Saved account is unreadable." })),
    );
    return {
      session: parsed.session,
      device: parsed.device,
      relayClient: { ...parsed.relayClient },
    } satisfies StoredAccount;
  });

  const saveUnlocked = Effect.fn("gustaf.account.saveUnlocked")(function* (account: StoredAccount) {
    if (isEmptyStoredAccount(account)) {
      yield* fileSystem
        .remove(accountPath, { force: true })
        .pipe(
          Effect.mapError(
            () => new GustafAccountError({ detail: "Cannot remove the saved Gustaf account." }),
          ),
        );
      return;
    }

    yield* requireEncryptionAvailable;
    const plaintext = yield* encodeStoredAccount(account).pipe(
      Effect.mapError(() => new GustafAccountError({ detail: "Cannot encode the account." })),
    );
    const encryptedBytes = yield* safeStorage
      .encryptString(plaintext)
      .pipe(
        Effect.mapError(
          () => new GustafAccountError({ detail: "Cannot encrypt the Gustaf account." }),
        ),
      );
    const encodedDoc = yield* encodeEncryptedDocument({
      version: 1,
      encryptedAccount: Base64.encode(encryptedBytes),
    }).pipe(
      Effect.mapError(() => new GustafAccountError({ detail: "Cannot encode the account." })),
    );

    const directory = path.dirname(accountPath);
    const suffix = NodeCrypto.randomBytes(6).toString("hex");
    const tempPath = `${accountPath}.${process.pid}.${suffix}.tmp`;
    yield* fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.mapError(
          () => new GustafAccountError({ detail: "Cannot create the Gustaf account directory." }),
        ),
      );
    yield* Effect.gen(function* () {
      yield* fileSystem.writeFileString(tempPath, `${encodedDoc}\n`);
      yield* fileSystem.rename(tempPath, accountPath);
    }).pipe(
      Effect.mapError(() => new GustafAccountError({ detail: "Cannot save the Gustaf account." })),
      Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
  });

  const readAccount = <A>(fn: (account: StoredAccount) => A) =>
    fileSemaphore.withPermits(1)(loadUnlocked.pipe(Effect.map(fn)));

  const changeAccount = <A>(fn: (account: StoredAccount) => A) =>
    fileSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const account = yield* loadUnlocked;
        const result = fn(account);
        yield* saveUnlocked(account);
        return result;
      }),
    );

  const requireSessionToken = readAccount((account) => account.session?.token ?? null).pipe(
    Effect.filterOrFail(
      (token): token is string => token !== null,
      () => new GustafAccountError({ detail: "Sign in to your Gustaf account first." }),
    ),
  );

  const forgetRejectedSession = <A>(
    effect: Effect.Effect<A, GustafCloudApi.GustafCloudApiError>,
  ): Effect.Effect<A, GustafAccountError> =>
    effect.pipe(
      Effect.catch((error) => {
        if (error._tag === "GustafCloudUnauthorizedError") {
          return changeAccount((account) => {
            account.session = null;
          }).pipe(
            Effect.ignore,
            Effect.andThen(Effect.fail(new GustafAccountError({ detail: error.message }))),
          );
        }
        return Effect.fail(new GustafAccountError({ detail: error.message }));
      }),
    );

  const syncRelayCredentialToBackend = Effect.gen(function* () {
    const device = yield* readAccount((account) => account.device).pipe(
      Effect.orElseSucceed(() => null),
    );
    const instances = yield* backendPool.list;
    const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
    if (primary === undefined) {
      return;
    }
    const ready = yield* primary.waitForReady(BACKEND_READY_TIMEOUT);
    if (!ready) {
      return;
    }
    const configOption = yield* primary.currentConfig;
    if (Option.isNone(configOption)) {
      return;
    }
    const bearer = yield* localAuth.getBearerToken.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Relay credential handoff skipped: local auth unavailable.", {
          error: error.message,
        }).pipe(Effect.as(null as string | null)),
      ),
    );
    if (bearer === null) {
      return;
    }
    const url = new URL("/api/relay-host/credential", configOption.value.httpBaseUrl).toString();
    let request =
      device !== null
        ? HttpClientRequest.put(url).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              relayUrl: apiBase,
              deviceId: device.id,
              token: device.token,
            }),
          )
        : HttpClientRequest.delete(url);
    request = HttpClientRequest.bearerToken(request, bearer);

    const response = yield* httpClient.execute(request).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.timeout(RELAY_HANDOFF_TIMEOUT),
      Effect.catch((error) =>
        Effect.logWarning("Relay credential handoff failed.", { error }).pipe(Effect.as(null)),
      ),
    );
    if (response !== null && (response.status < 200 || response.status >= 300)) {
      yield* Effect.logWarning("Relay credential handoff rejected by local backend.", {
        status: response.status,
      });
    }
  }).pipe(Effect.withSpan("gustaf.account.syncRelayCredential"));

  const sendHeartbeatOnce = Effect.gen(function* () {
    const deviceToken = yield* readAccount((account) => account.device?.token ?? null).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (deviceToken === null) {
      return;
    }
    yield* GustafCloudApi.sendHeartbeat({
      deviceToken,
      appVersion: environment.appVersion,
      platform: environment.platform,
      arch: environment.processArch,
      apiBase,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.catch((error) =>
        Effect.logWarning("Gustaf device heartbeat failed.", { error: error.message }),
      ),
    );
  }).pipe(Effect.withSpan("gustaf.account.sendHeartbeat"));

  const checkRelayClientKey = (key: string) =>
    RELAY_CLIENT_KEYS.has(key)
      ? Effect.void
      : Effect.fail(new GustafAccountError({ detail: "Unknown relay client entry" }));

  const serviceContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(serviceContext);
  const runOpenExternal = (url: string) => {
    const openFn = options?.openExternal ?? shell.openExternal;
    return runFork(openFn(url).pipe(Effect.ignore));
  };

  const revealMainWindow = Effect.gen(function* () {
    const win = yield* windows.currentMainOrFirst;
    if (Option.isSome(win)) {
      yield* windows.reveal(win.value);
    }
  });

  const getState = readAccount(toAccountState).pipe(Effect.withSpan("gustaf.account.getState"));

  const cancelSignIn = Effect.sync(() => {
    signInAttempt += 1;
    cancelActiveSignIn?.();
    cancelActiveSignIn = null;
  });

  const signIn = Effect.gen(function* () {
    signInAttempt += 1;
    const attempt = signInAttempt;
    cancelActiveSignIn?.();
    cancelActiveSignIn = null;

    const verifier = NodeCrypto.randomBytes(32).toString("base64url");
    const state = NodeCrypto.randomBytes(32).toString("base64url");

    const { code, redirectUri } = yield* waitForBrowserCode({
      apiBase,
      verifier,
      state,
      ...(options?.signInTimeoutMs !== undefined ? { timeoutMs: options.signInTimeoutMs } : {}),
      openExternal: runOpenExternal,
      registerCancel: (cancel) => {
        if (attempt !== signInAttempt) {
          cancel();
          return;
        }
        cancelActiveSignIn = cancel;
      },
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (attempt === signInAttempt) {
            cancelActiveSignIn = null;
          }
        }),
      ),
    );

    if (attempt !== signInAttempt) {
      return yield* new GustafAccountError({ detail: "Sign-in was cancelled." });
    }

    const grant = yield* GustafCloudApi.exchangeCode({
      code,
      codeVerifier: verifier,
      redirectUri,
      apiBase,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError((error) => new GustafAccountError({ detail: error.message })),
    );

    const { accountState, clearedDevice } = yield* changeAccount((account) => {
      let deviceCleared = false;
      if (account.device !== null && account.device.userId !== grant.user.id) {
        account.device = null;
        account.relayClient = {};
        deviceCleared = true;
      }
      account.session = {
        token: grant.token,
        expiresAt: grant.expiresAt,
        user: grant.user,
      };
      return { accountState: toAccountState(account), clearedDevice: deviceCleared };
    });

    yield* revealMainWindow;
    if (clearedDevice) {
      yield* syncRelayCredentialToBackend.pipe(Effect.forkDetach);
    }
    yield* sendHeartbeatOnce.pipe(Effect.forkDetach);
    return accountState;
  }).pipe(Effect.withSpan("gustaf.account.signIn"));

  const signOut = Effect.gen(function* () {
    const token = yield* readAccount((account) => account.session?.token ?? null);
    if (token !== null) {
      // Best effort: an offline sign-out must still forget the account locally.
      yield* GustafCloudApi.signOut({ token, apiBase }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.ignore,
      );
    }
    const nextState = yield* changeAccount((account) => {
      account.session = null;
      account.device = null;
      account.relayClient = {};
      return toAccountState(account);
    });
    yield* syncRelayCredentialToBackend.pipe(Effect.forkDetach);
    return nextState;
  }).pipe(Effect.withSpan("gustaf.account.signOut"));

  const listDevices = Effect.gen(function* () {
    const token = yield* requireSessionToken;
    const devices = yield* forgetRejectedSession(
      GustafCloudApi.listDevices({ token, apiBase }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    );
    const currentDeviceId = yield* readAccount((account) => account.device?.id ?? null);
    return devices.map((device) => ({
      ...device,
      current: currentDeviceId === device.id,
    }));
  }).pipe(Effect.withSpan("gustaf.account.listDevices"));

  const registerThisComputer = Effect.gen(function* () {
    const token = yield* requireSessionToken;
    const registered = yield* forgetRejectedSession(
      GustafCloudApi.registerComputer({
        token,
        name: readComputerName(environment.platform),
        apiBase,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    );
    const nextState = yield* changeAccount((account) => {
      if (account.session !== null) {
        account.device = {
          id: registered.device.id,
          token: registered.token,
          userId: account.session.user.id,
        };
      }
      return toAccountState(account);
    });
    yield* syncRelayCredentialToBackend.pipe(Effect.forkDetach);
    yield* sendHeartbeatOnce.pipe(Effect.forkDetach);
    return nextState;
  }).pipe(Effect.withSpan("gustaf.account.registerThisComputer"));

  const revokeDevice = Effect.fn("gustaf.account.revokeDevice")(function* (deviceId: string) {
    if (!isDeviceId(deviceId)) {
      return yield* new GustafAccountError({ detail: "Unknown device" });
    }
    const token = yield* requireSessionToken;
    yield* forgetRejectedSession(
      GustafCloudApi.revokeDevice({ token, deviceId, apiBase }).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    );
    const { accountState, wasThisComputer } = yield* changeAccount((account) => {
      const thisComputer = account.device?.id === deviceId;
      if (thisComputer) {
        account.device = null;
      }
      return { accountState: toAccountState(account), wasThisComputer: thisComputer };
    });
    if (wasThisComputer) {
      yield* syncRelayCredentialToBackend.pipe(Effect.forkDetach);
    }
    return accountState;
  });

  const reportProblem = Effect.fn("gustaf.account.reportProblem")(function* (
    input: GustafReportProblemInput,
  ) {
    if (Array.from(input.message).length > REPORT_MESSAGE_CHARS) {
      return yield* new GustafAccountError({
        detail: `The description is longer than ${REPORT_MESSAGE_CHARS} characters.`,
      });
    }
    const redacted = redactText(input.message.trim(), environment.homeDirectory);
    if (redacted.length === 0) {
      return yield* new GustafAccountError({ detail: "Describe the problem first." });
    }
    const boundedMessage = Array.from(redacted).slice(0, REPORT_MESSAGE_CHARS).join("");
    const token = yield* requireSessionToken;
    const deviceId = yield* readAccount((account) => account.device?.id ?? null);
    const logs = input.attachLogs
      ? collectDiagnostics(environment.logDir, environment.homeDirectory)
      : null;

    yield* forgetRejectedSession(
      GustafCloudApi.sendReport({
        token,
        message: boundedMessage,
        logs,
        appVersion: environment.appVersion,
        platform: environment.platform,
        arch: environment.processArch,
        deviceId,
        apiBase,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
    );
  });

  const getRelayClientCredential = readAccount((account) =>
    account.device === null
      ? null
      : ({
          deviceId: account.device.id,
          deviceToken: account.device.token,
          deviceName: readComputerName(environment.platform),
        } satisfies GustafRelayClientCredential),
  ).pipe(
    Effect.filterOrFail(
      (credential): credential is GustafRelayClientCredential => credential !== null,
      () =>
        new GustafAccountError({
          detail:
            "Sign in and register this computer under Settings → Account to use the Gustaf relay.",
        }),
    ),
    Effect.withSpan("gustaf.account.getRelayClientCredential"),
  );

  const getRelayClientStorageItem = Effect.fn("gustaf.account.getRelayClientStorageItem")(
    function* (key: string) {
      yield* checkRelayClientKey(key);
      return yield* readAccount((account) => account.relayClient[key] ?? null);
    },
  );

  const setRelayClientStorageItem = Effect.fn("gustaf.account.setRelayClientStorageItem")(
    function* (key: string, value: string) {
      yield* checkRelayClientKey(key);
      if (Buffer.byteLength(value, "utf8") > RELAY_CLIENT_VALUE_LIMIT) {
        return yield* new GustafAccountError({
          detail: "The relay client entry is too large",
        });
      }
      yield* changeAccount((account) => {
        account.relayClient[key] = value;
      });
    },
  );

  const getClientConfig = Effect.gen(function* () {
    const credential = yield* readAccount(
      (account) => account.device?.token ?? account.session?.token ?? null,
    ).pipe(Effect.orElseSucceed(() => null));
    return yield* GustafCloudApi.fetchClientConfig({
      version: environment.appVersion,
      platform: environment.platform,
      token: credential,
      apiBase,
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError((error) => new GustafAccountError({ detail: error.message })),
    );
  }).pipe(Effect.withSpan("gustaf.account.getClientConfig"));

  const startBackgroundTasks = Effect.gen(function* () {
    yield* Effect.forkScoped(syncRelayCredentialToBackend);
    yield* Effect.forkScoped(
      sendHeartbeatOnce.pipe(Effect.repeat(Schedule.spaced(HEARTBEAT_INTERVAL))),
    );
  });

  return GustafAccount.of({
    getState,
    signIn,
    cancelSignIn,
    signOut,
    listDevices,
    registerThisComputer,
    revokeDevice,
    reportProblem,
    getRelayClientCredential,
    getRelayClientStorageItem,
    setRelayClientStorageItem,
    getClientConfig,
    syncRelayCredentialToBackend,
    startBackgroundTasks,
  });
});

const make = makeWithOptions();
export const layer = Layer.effect(GustafAccount, make);
