// @effect-diagnostics globalFetchInEffect:off -- Test exercises the loopback HTTP callback server from outside Effect HttpClient.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as GustafAccount from "./GustafAccount.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function makeMockSafeStorage(available = true) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`enc:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("corrupt payload"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function makeTestLayer(options: {
  readonly baseDir: string;
  readonly apiBase?: string;
  readonly httpHandler: (request: RecordedRequest) => {
    readonly status: number;
    readonly body?: unknown;
  };
  readonly openExternal?: (url: string) => Effect.Effect<boolean>;
  readonly signInTimeoutMs?: number;
  readonly encryptionAvailable?: boolean;
}) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: options.baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.23.0",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: options.baseDir })),
    ),
  );

  const mockHttpClient = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((req) =>
      Effect.sync(() => {
        let parsedBody: unknown = undefined;
        if (req.body._tag === "Uint8Array") {
          const text = textDecoder.decode(req.body.body);
          parsedBody = text.length > 0 ? JSON.parse(text) : undefined;
        }
        const authorization = req.headers.authorization ?? null;
        const result = options.httpHandler({
          method: req.method,
          url: req.url,
          authorization,
          body: parsedBody,
        });
        return HttpClientResponse.fromWeb(
          req,
          new Response(result.body !== undefined ? JSON.stringify(result.body) : null, {
            status: result.status,
            headers: result.body !== undefined ? { "content-type": "application/json" } : {},
          }),
        );
      }),
    ),
  );

  const mockBackendPool = Layer.mock(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([
      {
        id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
        label: Effect.succeed("Primary"),
        start: Effect.void,
        stop: () => Effect.void,
        waitForReady: () => Effect.succeed(true),
        currentConfig: Effect.succeedSome({
          httpBaseUrl: new URL("http://127.0.0.1:43210"),
        } as never),
        snapshot: Effect.die("unused"),
      },
    ]),
  });

  const mockLocalAuth = Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
    getBearerToken: Effect.succeed("local-bearer-token"),
  });

  const mockWindow = Layer.mock(ElectronWindow.ElectronWindow, {
    currentMainOrFirst: Effect.succeedNone,
    reveal: () => Effect.void,
  });

  const mockShell = Layer.mock(ElectronShell.ElectronShell, {
    openExternal: (rawUrl) =>
      options.openExternal ? options.openExternal(String(rawUrl)) : Effect.succeed(true),
  });

  const deps = Layer.mergeAll(
    layerEnvironment,
    makeMockSafeStorage(options.encryptionAvailable ?? true),
    mockHttpClient,
    mockBackendPool,
    mockLocalAuth,
    mockWindow,
    mockShell,
    NodeServices.layer,
    NodeCrypto.layer,
    Layer.succeed(
      HostProcess.Environment,
      options.apiBase ? { GUSTAF_API_URL: options.apiBase } : {},
    ),
  );

  return Layer.effect(
    GustafAccount.GustafAccount,
    GustafAccount.makeWithOptions({
      ...(options.signInTimeoutMs !== undefined
        ? { signInTimeoutMs: options.signInTimeoutMs }
        : {}),
      ...(options.openExternal ? { openExternal: options.openExternal } : {}),
    }),
  ).pipe(Layer.provideMerge(deps));
}

describe("GustafAccount pure helpers", () => {
  it("computes PKCE S256 challenge matching RFC 7636 Appendix B", () => {
    assert.strictEqual(
      GustafAccount.pkceCodeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("parses loopback OAuth callbacks", () => {
    assert.deepStrictEqual(GustafAccount.parseCallback("/callback?code=a%2Bb&state=s1", "s1"), {
      kind: "code",
      code: "a+b",
    });
    assert.deepStrictEqual(
      GustafAccount.parseCallback("/callback?error=access_denied&state=s1", "s1"),
      { kind: "denied", error: "access_denied" },
    );
    assert.deepStrictEqual(GustafAccount.parseCallback("/callback?state=s1", "s1"), {
      kind: "denied",
      error: "invalid_response",
    });
    assert.deepStrictEqual(GustafAccount.parseCallback("/callback?code=a&state=other", "s1"), {
      kind: "state_mismatch",
    });
    assert.deepStrictEqual(GustafAccount.parseCallback("/favicon.ico", "s1"), { kind: "other" });
    assert.deepStrictEqual(
      GustafAccount.parseCallback("http://evil/callback?code=a&state=s1", "s1"),
      { kind: "other" },
    );
  });

  it("formats denied error messages and validates device IDs", () => {
    assert.strictEqual(
      GustafAccount.deniedMessage("access_denied"),
      "Sign-in was cancelled in the browser.",
    );
    assert.strictEqual(
      GustafAccount.deniedMessage("server_error"),
      "Sign-in failed (server_error).",
    );
    assert.strictEqual(GustafAccount.deniedMessage("<script>"), "Sign-in failed.");

    assert.isTrue(GustafAccount.isDeviceId("3f2b9c1e-0b7a-4d4e-9a55-0c1d2e3f4a5b"));
    for (const invalid of ["", "../me", "a/b", "a?b", "a b"]) {
      assert.isFalse(GustafAccount.isDeviceId(invalid));
    }
  });
});

describe("GustafAccount service", () => {
  it.effect(
    "signs in via PKCE loopback, persists encrypted state, registers device, and syncs relay credential",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gustaf-account-" });
          const requests: Array<RecordedRequest> = [];
          let callbackStatus = 0;

          const layer = makeTestLayer({
            baseDir,
            apiBase: "https://cloud.example.test",
            openExternal: (rawUrl) =>
              Effect.promise(async () => {
                const parsed = new URL(rawUrl);
                const redirectUri = parsed.searchParams.get("redirect_uri")!;
                const state = parsed.searchParams.get("state")!;
                const res = await fetch(`${redirectUri}?code=auth-code-123&state=${state}`);
                callbackStatus = res.status;
                return true;
              }),
            httpHandler: (request) => {
              requests.push(request);
              if (request.url === "https://cloud.example.test/v1/auth/app/token") {
                return {
                  status: 200,
                  body: {
                    token: "session-secret-tok",
                    expiresAt: "2026-12-31T00:00:00.000Z",
                    user: { id: "user-1", name: "Max", email: "max@example.com", image: null },
                  },
                };
              }
              if (
                request.url === "https://cloud.example.test/v1/devices" &&
                request.method === "POST"
              ) {
                return {
                  status: 200,
                  body: {
                    device: {
                      id: "dev-1",
                      name: "Mac Studio",
                      kind: "computer",
                      createdAt: "2026-11-23T00:00:00.000Z",
                      lastSeenAt: null,
                    },
                    token: "gdt_device-secret-tok",
                  },
                };
              }
              if (request.url.startsWith("https://cloud.example.test/v1/devices/heartbeat")) {
                return { status: 204 };
              }
              if (request.url === "http://127.0.0.1:43210/api/relay-host/credential") {
                return { status: 204 };
              }
              if (
                request.url === "https://cloud.example.test/v1/devices/dev-1" &&
                request.method === "DELETE"
              ) {
                return { status: 204 };
              }
              if (request.url === "https://cloud.example.test/v1/auth/sign-out") {
                return { status: 204 };
              }
              return { status: 404 };
            },
          });

          yield* Effect.gen(function* () {
            const account = yield* GustafAccount.GustafAccount;
            const initial = yield* account.getState;
            assert.isFalse(initial.signedIn);
            assert.isNull(initial.deviceId);

            const signedIn = yield* account.signIn;
            assert.strictEqual(callbackStatus, 200);
            assert.isTrue(signedIn.signedIn);
            assert.strictEqual(signedIn.user?.id, "user-1");
            assert.isFalse("token" in signedIn);

            const registered = yield* account.registerThisComputer;
            assert.strictEqual(registered.deviceId, "dev-1");

            const cred = yield* account.getRelayClientCredential;
            assert.strictEqual(cred.deviceId, "dev-1");
            assert.strictEqual(cred.deviceToken, "gdt_device-secret-tok");

            // Wait briefly for detached relay sync fiber, or trigger deterministic sync directly
            yield* account.syncRelayCredentialToBackend;
            const putReq = requests.find(
              (r) =>
                r.method === "PUT" && r.url === "http://127.0.0.1:43210/api/relay-host/credential",
            );
            assert.isDefined(putReq);
            assert.strictEqual(putReq?.authorization, "Bearer local-bearer-token");
            assert.deepStrictEqual(putReq?.body, {
              relayUrl: "https://cloud.example.test",
              deviceId: "dev-1",
              token: "gdt_device-secret-tok",
            });

            const accountFile = path.join(baseDir, "userdata", "gustaf-account.encrypted.json");
            const rawOnDisk = yield* fs.readFileString(accountFile);
            assert.isFalse(rawOnDisk.includes("session-secret-tok"));
            assert.isFalse(rawOnDisk.includes("gdt_device-secret-tok"));

            const afterRevoke = yield* account.revokeDevice("dev-1");
            assert.isNull(afterRevoke.deviceId);
            yield* account.syncRelayCredentialToBackend;
            assert.isDefined(
              requests.find(
                (r) =>
                  r.method === "DELETE" &&
                  r.url === "http://127.0.0.1:43210/api/relay-host/credential",
              ),
            );

            const afterSignOut = yield* account.signOut;
            assert.isFalse(afterSignOut.signedIn);
            assert.isFalse(yield* fs.exists(accountFile));
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "forgets rejected session on 401 while keeping device, and supports signed-out clientConfig",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gustaf-account-401-" });
          const requests: Array<RecordedRequest> = [];

          const layer = makeTestLayer({
            baseDir,
            apiBase: "https://cloud.example.test",
            openExternal: (rawUrl) =>
              Effect.promise(async () => {
                const parsed = new URL(rawUrl);
                await fetch(
                  `${parsed.searchParams.get("redirect_uri")!}?code=c1&state=${parsed.searchParams.get("state")!}`,
                );
                return true;
              }),
            httpHandler: (request) => {
              requests.push(request);
              if (request.url.endsWith("/v1/auth/app/token")) {
                return {
                  status: 200,
                  body: {
                    token: "sess-1",
                    expiresAt: "2026-12-31T00:00:00.000Z",
                    user: { id: "u1" },
                  },
                };
              }
              if (request.url.endsWith("/v1/devices") && request.method === "POST") {
                return {
                  status: 200,
                  body: {
                    device: { id: "d1", name: "Mac", kind: "computer", createdAt: "2026-01-01" },
                    token: "gdt_1",
                  },
                };
              }
              if (request.url.endsWith("/v1/devices") && request.method === "GET") {
                return { status: 401 };
              }
              if (request.url.includes("/v1/client-config")) {
                return { status: 200, body: { featureFlags: { beta: true }, announcements: [] } };
              }
              return { status: 204 };
            },
          });

          yield* Effect.gen(function* () {
            const account = yield* GustafAccount.GustafAccount;
            // Signed-out clientConfig works
            const preConfig = yield* account.getClientConfig;
            assert.deepStrictEqual(preConfig, { featureFlags: { beta: true }, announcements: [] });

            yield* account.signIn;
            yield* account.registerThisComputer;

            const err = yield* Effect.flip(account.listDevices);
            assert.strictEqual(err.message, "Your Gustaf account session has expired.");

            const state = yield* account.getState;
            assert.isFalse(state.signedIn);
            assert.strictEqual(state.deviceId, "d1");

            // Client config sends device token once device exists
            yield* account.getClientConfig;
            const configReqs = requests.filter((r) => r.url.includes("/v1/client-config"));
            assert.isNull(configReqs[0]?.authorization);
            assert.strictEqual(configReqs[1]?.authorization, "Bearer gdt_1");
          }).pipe(Effect.provide(layer));
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("validates relayClient storage keys/limits and redacts problem reports with logs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "gustaf-account-report-" });
        const requests: Array<RecordedRequest> = [];

        const layer = makeTestLayer({
          baseDir,
          apiBase: "https://cloud.example.test",
          openExternal: (rawUrl) =>
            Effect.promise(async () => {
              const parsed = new URL(rawUrl);
              await fetch(
                `${parsed.searchParams.get("redirect_uri")!}?code=c1&state=${parsed.searchParams.get("state")!}`,
              );
              return true;
            }),
          httpHandler: (request) => {
            requests.push(request);
            if (request.url.endsWith("/v1/auth/app/token")) {
              return {
                status: 200,
                body: {
                  token: "sess-1",
                  expiresAt: "2026-12-31T00:00:00.000Z",
                  user: { id: "u1" },
                },
              };
            }
            return { status: 204 };
          },
        });

        yield* Effect.gen(function* () {
          const account = yield* GustafAccount.GustafAccount;
          const env = yield* DesktopEnvironment.DesktopEnvironment;
          yield* fs.makeDirectory(env.logDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(env.logDir, "desktop.log"),
            `opening ${baseDir}/secret token=sk-1234567890abcdef1234\n`,
          );

          // Relay client storage checks
          const badKeyErr = yield* Effect.flip(account.getRelayClientStorageItem("bad.key"));
          assert.strictEqual(badKeyErr.message, "Unknown relay client entry");

          const tooLargeErr = yield* Effect.flip(
            account.setRelayClientStorageItem("gustaf.relay.hosts", "a".repeat(65 * 1024)),
          );
          assert.strictEqual(tooLargeErr.message, "The relay client entry is too large");

          yield* account.setRelayClientStorageItem("gustaf.relay.phone-key", "pk-123");
          assert.strictEqual(
            yield* account.getRelayClientStorageItem("gustaf.relay.phone-key"),
            "pk-123",
          );

          yield* account.signIn;

          const tooLongMsg = yield* Effect.flip(
            account.reportProblem({ message: "x".repeat(5001), attachLogs: false }),
          );
          assert.strictEqual(tooLongMsg.message, "The description is longer than 5000 characters.");

          const emptyMsg = yield* Effect.flip(
            account.reportProblem({ message: "   ", attachLogs: false }),
          );
          assert.strictEqual(emptyMsg.message, "Describe the problem first.");

          yield* account.reportProblem({
            message: `Error at ${baseDir}/foo token=ghp_12345678901234567890`,
            attachLogs: true,
          });

          const reportReq = requests.find((r) => r.url.endsWith("/v1/reports"));
          assert.isDefined(reportReq);
          const body = reportReq?.body as { message: string; logs: string; client: string };
          assert.strictEqual(body.client, "desktop");
          assert.isFalse(body.message.includes(baseDir));
          assert.isFalse(body.message.includes("ghp_12345678901234567890"));
          assert.include(body.message, "~/foo");
          assert.include(body.logs, "[redacted]");
          assert.isFalse(body.logs.includes("sk-1234567890abcdef1234"));
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
