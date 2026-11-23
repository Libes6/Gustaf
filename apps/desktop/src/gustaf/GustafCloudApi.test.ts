import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import {
  DEFAULT_GUSTAF_CLOUD_API_BASE,
  GustafCloudRequestError,
  GustafCloudUnauthorizedError,
  buildSignInUrl,
  exchangeCode,
  fetchClientConfig,
  listDevices,
  registerComputer,
  resolveClientConfigPlatform,
  resolveGustafCloudApiBase,
  resolveHeartbeatPlatform,
  resolveReportPlatform,
  revokeDevice,
  sendHeartbeat,
  sendReport,
  signOut,
} from "./GustafCloudApi.ts";

const textDecoder = new TextDecoder();

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: HttpClientRequest.HttpClientRequest["headers"];
  readonly body: unknown;
}

function decodeBody(request: HttpClientRequest.HttpClientRequest): unknown {
  if (request.body._tag === "Empty") {
    return undefined;
  }
  assert.equal(request.body._tag, "Uint8Array");
  if (request.body._tag !== "Uint8Array") {
    return undefined;
  }
  const text = textDecoder.decode(request.body.body);
  return text.length > 0 ? JSON.parse(text) : undefined;
}

function makeMockHttpClient(handler: (request: RecordedRequest) => Response): {
  readonly requests: Array<RecordedRequest>;
  readonly client: HttpClient.HttpClient;
} {
  const requests: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const recorded: RecordedRequest = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: decodeBody(request),
      };
      requests.push(recorded);
      return HttpClientResponse.fromWeb(request, handler(recorded));
    }),
  );
  return { requests, client };
}

describe("GustafCloudApi", () => {
  describe("helpers", () => {
    it.each([
      { input: undefined, expected: DEFAULT_GUSTAF_CLOUD_API_BASE },
      { input: "", expected: DEFAULT_GUSTAF_CLOUD_API_BASE },
      { input: "   ", expected: DEFAULT_GUSTAF_CLOUD_API_BASE },
      { input: "not-a-url", expected: DEFAULT_GUSTAF_CLOUD_API_BASE },
      { input: "ftp://cloud.example.test", expected: DEFAULT_GUSTAF_CLOUD_API_BASE },
      { input: "javascript:alert(1)", expected: DEFAULT_GUSTAF_CLOUD_API_BASE },
      {
        input: "https://cloud.example.test/v1/ignored?a=1",
        expected: "https://cloud.example.test",
      },
      { input: "  http://127.0.0.1:8787/path  ", expected: "http://127.0.0.1:8787" },
    ])("resolveGustafCloudApiBase($input) -> $expected", ({ input, expected }) => {
      assert.equal(resolveGustafCloudApiBase(input), expected);
    });

    it("buildSignInUrl appends PKCE and redirect query parameters", () => {
      const built = new URL(
        buildSignInUrl({
          redirectUri: "http://127.0.0.1:41234/callback",
          codeChallenge: "challenge-abc",
          state: "state-xyz",
          apiBase: "https://cloud.example.test",
        }),
      );
      assert.equal(built.origin, "https://cloud.example.test");
      assert.equal(built.pathname, "/v1/auth/app/start");
      assert.equal(built.searchParams.get("redirect_uri"), "http://127.0.0.1:41234/callback");
      assert.equal(built.searchParams.get("code_challenge"), "challenge-abc");
      assert.equal(built.searchParams.get("code_challenge_method"), "S256");
      assert.equal(built.searchParams.get("state"), "state-xyz");

      const defaultBuilt = new URL(
        buildSignInUrl({
          redirectUri: "gustaf://callback",
          codeChallenge: "c1",
          state: "s1",
        }),
      );
      assert.equal(defaultBuilt.origin, DEFAULT_GUSTAF_CLOUD_API_BASE);
    });

    it.each([
      { platform: "darwin", arch: "arm64", expected: "macos-arm64" },
      { platform: "macos", arch: "aarch64", expected: "macos-arm64" },
      { platform: "win32", arch: "x64", expected: "windows-x64" },
      { platform: "windows", arch: "x86_64", expected: "windows-x64" },
      { platform: "linux", arch: "x64", expected: "linux-x64" },
      { platform: "linux", arch: "arm64", expected: "linux-arm64" },
      { platform: "freebsd", arch: "x64", expected: null },
      { platform: "darwin", arch: "ia32", expected: null },
    ])(
      "resolveHeartbeatPlatform($platform, $arch) -> $expected",
      ({ platform, arch, expected }) => {
        assert.equal(resolveHeartbeatPlatform(platform, arch), expected);
      },
    );

    it.each([
      { platform: "darwin", expected: "macos" },
      { platform: "macos", expected: "macos" },
      { platform: "win32", expected: "windows" },
      { platform: "windows", expected: "windows" },
      { platform: "linux", expected: "linux" },
      { platform: "freebsd", expected: "linux" },
    ] as const)("resolveClientConfigPlatform($platform) -> $expected", ({ platform, expected }) => {
      assert.equal(resolveClientConfigPlatform(platform), expected);
    });

    it.each([
      { platform: "darwin", arch: "arm64", expected: "macos arm64" },
      { platform: "win32", arch: "x64", expected: "windows x64" },
      { platform: "linux", arch: "x64", expected: "linux x64" },
    ])("resolveReportPlatform($platform, $arch) -> $expected", ({ platform, arch, expected }) => {
      assert.equal(resolveReportPlatform(platform, arch), expected);
    });
  });

  describe("requests and responses", () => {
    it.effect("exchangeCode posts PKCE payload and normalizes optional user fields", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() =>
          Response.json({
            token: "session-token-1",
            expiresAt: "2026-12-31T00:00:00.000Z",
            user: {
              id: "usr_1",
              email: "ada@example.test",
            },
          }),
        );

        const grant = yield* exchangeCode({
          code: "auth-code",
          codeVerifier: "verifier-1",
          redirectUri: "http://127.0.0.1:41234/callback",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.deepEqual(grant, {
          token: "session-token-1",
          expiresAt: "2026-12-31T00:00:00.000Z",
          user: {
            id: "usr_1",
            name: null,
            email: "ada@example.test",
            image: null,
          },
        });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, "POST");
        assert.equal(requests[0]!.url, "https://cloud.example.test/v1/auth/app/token");
        assert.equal(requests[0]!.headers.accept, "application/json");
        assert.isUndefined(requests[0]!.headers.authorization);
        assert.deepEqual(requests[0]!.body, {
          code: "auth-code",
          code_verifier: "verifier-1",
          redirect_uri: "http://127.0.0.1:41234/callback",
        });
      }),
    );

    it.effect("signOut posts empty JSON body with bearer authorization", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() => new Response(null, { status: 204 }));

        yield* signOut({
          token: "tok-signout",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, "POST");
        assert.equal(requests[0]!.url, "https://cloud.example.test/v1/auth/sign-out");
        assert.equal(requests[0]!.headers.authorization, "Bearer tok-signout");
        assert.deepEqual(requests[0]!.body, {});
      }),
    );

    it.effect(
      "listDevices fetches devices with bearer authorization and normalizes lastSeenAt",
      () =>
        Effect.gen(function* () {
          const { requests, client } = makeMockHttpClient(() =>
            Response.json({
              devices: [
                {
                  id: "dev_1",
                  name: "MacBook Pro",
                  kind: "computer",
                  createdAt: "2026-01-01T00:00:00.000Z",
                },
                {
                  id: "dev_2",
                  name: "iPhone",
                  kind: "mobile",
                  createdAt: "2026-01-02T00:00:00.000Z",
                  lastSeenAt: "2026-02-01T00:00:00.000Z",
                },
              ],
            }),
          );

          const devices = yield* listDevices({
            token: "tok-list",
            apiBase: "https://cloud.example.test",
          }).pipe(Effect.provideService(HttpClient.HttpClient, client));

          assert.deepEqual(devices, [
            {
              id: "dev_1",
              name: "MacBook Pro",
              kind: "computer",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastSeenAt: null,
            },
            {
              id: "dev_2",
              name: "iPhone",
              kind: "mobile",
              createdAt: "2026-01-02T00:00:00.000Z",
              lastSeenAt: "2026-02-01T00:00:00.000Z",
            },
          ]);
          assert.equal(requests.length, 1);
          assert.equal(requests[0]!.method, "GET");
          assert.equal(requests[0]!.url, "https://cloud.example.test/v1/devices");
          assert.equal(requests[0]!.headers.authorization, "Bearer tok-list");
          assert.isUndefined(requests[0]!.body);
        }),
    );

    it.effect("registerComputer posts computer device registration and decodes device token", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() =>
          Response.json({
            device: {
              id: "dev_9",
              name: "Workstation",
              kind: "computer",
              createdAt: "2026-03-01T00:00:00.000Z",
            },
            token: "dev-tok-9",
          }),
        );

        const registered = yield* registerComputer({
          token: "tok-reg",
          name: "Workstation",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.deepEqual(registered, {
          device: {
            id: "dev_9",
            name: "Workstation",
            kind: "computer",
            createdAt: "2026-03-01T00:00:00.000Z",
            lastSeenAt: null,
          },
          token: "dev-tok-9",
        });
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, "POST");
        assert.equal(requests[0]!.url, "https://cloud.example.test/v1/devices");
        assert.equal(requests[0]!.headers.authorization, "Bearer tok-reg");
        assert.deepEqual(requests[0]!.body, { name: "Workstation", kind: "computer" });
      }),
    );

    it.effect("sendHeartbeat sends device token and normalized platform string", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() => new Response(null, { status: 204 }));

        yield* sendHeartbeat({
          deviceToken: "dev-tok-1",
          appVersion: "0.23.0",
          platform: "darwin",
          arch: "arm64",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, "POST");
        assert.equal(requests[0]!.url, "https://cloud.example.test/v1/devices/heartbeat");
        assert.equal(requests[0]!.headers.authorization, "Bearer dev-tok-1");
        assert.deepEqual(requests[0]!.body, {
          appVersion: "0.23.0",
          platform: "macos-arm64",
        });
      }),
    );

    it.effect("sendHeartbeat fails locally without HTTP when platform is unsupported", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() =>
          Response.json({ unexpected: true }, { status: 500 }),
        );

        const error = yield* sendHeartbeat({
          deviceToken: "dev-tok-1",
          appVersion: "0.23.0",
          platform: "freebsd",
          arch: "x64",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        assert.instanceOf(error, GustafCloudRequestError);
        assert.equal(requests.length, 0);
      }),
    );

    it.effect("revokeDevice sends DELETE to /v1/devices/:deviceId with bearer token", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() => new Response(null, { status: 204 }));

        yield* revokeDevice({
          token: "tok-revoke",
          deviceId: "dev_42",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, "DELETE");
        assert.equal(requests[0]!.url, "https://cloud.example.test/v1/devices/dev_42");
        assert.equal(requests[0]!.headers.authorization, "Bearer tok-revoke");
        assert.isUndefined(requests[0]!.body);
      }),
    );

    it.effect("fetchClientConfig passes query params and optional authorization header", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() =>
          Response.json({ minVersion: "0.20.0", featureFlags: { relay: true } }),
        );

        const unauthenticated = yield* fetchClientConfig({
          version: "0.23.0",
          platform: "win32",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        const authenticated = yield* fetchClientConfig({
          version: "0.23.0",
          platform: "darwin",
          token: "tok-cfg",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.deepEqual(unauthenticated, { minVersion: "0.20.0", featureFlags: { relay: true } });
        assert.deepEqual(authenticated, { minVersion: "0.20.0", featureFlags: { relay: true } });
        assert.equal(requests.length, 2);

        const firstUrl = new URL(requests[0]!.url);
        assert.equal(requests[0]!.method, "GET");
        assert.equal(firstUrl.pathname, "/v1/client-config");
        assert.equal(firstUrl.searchParams.get("kind"), "desktop");
        assert.equal(firstUrl.searchParams.get("version"), "0.23.0");
        assert.equal(firstUrl.searchParams.get("platform"), "windows");
        assert.isUndefined(requests[0]!.headers.authorization);

        const secondUrl = new URL(requests[1]!.url);
        assert.equal(requests[1]!.method, "GET");
        assert.equal(secondUrl.searchParams.get("platform"), "macos");
        assert.equal(requests[1]!.headers.authorization, "Bearer tok-cfg");
      }),
    );

    it.effect("sendReport posts report payload with normalized platform and bearer token", () =>
      Effect.gen(function* () {
        const { requests, client } = makeMockHttpClient(() => new Response(null, { status: 204 }));

        yield* sendReport({
          token: "tok-report",
          message: "Something went wrong",
          logs: "== Shell and server output ==\nline",
          appVersion: "0.23.0",
          platform: "darwin",
          arch: "arm64",
          deviceId: "dev_7",
          apiBase: "https://cloud.example.test",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));

        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, "POST");
        assert.equal(requests[0]!.url, "https://cloud.example.test/v1/reports");
        assert.equal(requests[0]!.headers.authorization, "Bearer tok-report");
        assert.deepEqual(requests[0]!.body, {
          client: "desktop",
          message: "Something went wrong",
          logs: "== Shell and server output ==\nline",
          appVersion: "0.23.0",
          platform: "macos arm64",
          deviceId: "dev_7",
        });
      }),
    );
  });

  describe("error mapping", () => {
    it.effect("maps HTTP 401 to GustafCloudUnauthorizedError", () =>
      Effect.gen(function* () {
        const { client } = makeMockHttpClient(() => new Response("unauthorized", { status: 401 }));

        const error = yield* listDevices({ token: "expired" }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip,
        );

        assert.instanceOf(error, GustafCloudUnauthorizedError);
        assert.equal(error._tag, "GustafCloudUnauthorizedError");
      }),
    );

    it.effect("maps HTTP 429 to GustafCloudRequestError", () =>
      Effect.gen(function* () {
        const { client } = makeMockHttpClient(() => new Response("rate limited", { status: 429 }));

        const error = yield* sendReport({
          token: "tok",
          message: "hi",
          logs: null,
          appVersion: "0.23.0",
          platform: "linux",
          arch: "x64",
          deviceId: null,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        assert.instanceOf(error, GustafCloudRequestError);
        assert.equal(error._tag, "GustafCloudRequestError");
        assert.equal(error.detail, "Too many requests to the Gustaf cloud. Try again later.");
      }),
    );

    it.effect("maps HTTP 500 to GustafCloudRequestError", () =>
      Effect.gen(function* () {
        const { client } = makeMockHttpClient(() => new Response("boom", { status: 500 }));

        const error = yield* revokeDevice({ token: "tok", deviceId: "dev_1" }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.flip,
        );

        assert.instanceOf(error, GustafCloudRequestError);
        assert.equal(error._tag, "GustafCloudRequestError");
        assert.equal(error.detail, "The Gustaf cloud answered with HTTP 500.");
      }),
    );

    it.effect("maps empty token on exchangeCode to GustafCloudRequestError", () =>
      Effect.gen(function* () {
        const { client } = makeMockHttpClient(() =>
          Response.json({
            token: "",
            expiresAt: "2026-12-31T00:00:00.000Z",
            user: { id: "usr_1" },
          }),
        );

        const error = yield* exchangeCode({
          code: "code",
          codeVerifier: "verifier",
          redirectUri: "http://127.0.0.1:41234/callback",
        }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);

        assert.instanceOf(error, GustafCloudRequestError);
        assert.equal(error._tag, "GustafCloudRequestError");
        assert.equal(error.detail, "The Gustaf cloud did not return a session.");
      }),
    );
  });
});
