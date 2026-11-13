import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const TEST_ENV = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
  T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
};

const expiredStoredToken = new TextEncoder().encode(
  JSON.stringify({ accessToken: "expired", refreshToken: "refresh-token-1", expiresAtEpochMs: 0 }),
);

const provideRefreshManager = (
  httpClient: HttpClient.HttpClient,
  secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.succeedSome(expiredStoredToken),
  }),
) =>
  Effect.provide(
    CliTokenManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, httpClient),
          secrets,
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: TEST_ENV }))),
    ),
  );

it.effect(
  "persists rotated credentials under the lock despite shutdown, while queued callers can cancel",
  () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const persistStarted = yield* Deferred.make<void>();
      const releasePersist = yield* Deferred.make<void>();
      let stored = expiredStoredToken;
      let reads = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
              token_type: "bearer",
            }),
          );
        }),
      );
      const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () =>
          Effect.sync(() => {
            reads++;
            return Option.some(stored);
          }),
        set: (_name, value) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(persistStarted, undefined);
            yield* Deferred.await(releasePersist);
            stored = new Uint8Array(value);
          }),
      });

      yield* Effect.gen(function* () {
        const manager = yield* CliTokenManager.CloudCliTokenManager;
        const refresh = yield* manager.getExisting.pipe(Effect.forkChild);
        assert.isTrue(
          yield* Effect.raceFirst(
            Deferred.await(requestStarted).pipe(Effect.as(true)),
            Fiber.await(refresh).pipe(Effect.as(false)),
          ),
          "refresh failed before reaching the endpoint",
        );
        const waiter = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(waiter);
        assert.equal(reads, 1, "queued caller must not read credentials during refresh");
        const interruption = yield* Fiber.interrupt(refresh).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseRequest, undefined);
        const reachedPersist = yield* Effect.raceFirst(
          Deferred.await(persistStarted).pipe(Effect.as(true)),
          Fiber.await(refresh).pipe(Effect.as(false)),
        );
        assert.isTrue(reachedPersist, "shutdown discarded the rotated credential");
        const reader = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.equal(reads, 1, "credential lock must cover persistence");
        yield* Deferred.succeed(releasePersist, undefined);
        yield* Fiber.join(interruption);
        const token = Option.getOrThrow(yield* Fiber.join(reader));
        assert.equal(token.refreshToken, "rotated-refresh");
        assert.equal(token.accessToken, "rotated-access");
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseRequest, undefined)),
        Effect.ensuring(Deferred.succeed(releasePersist, undefined)),
        provideRefreshManager(httpClient, secrets),
      );
    }),
);

it.effect.each([
  { status: 400, code: "invalid_grant", requiresLogin: true, diagnostic: true },
  { status: 403, code: "private-provider-secret", requiresLogin: true, diagnostic: false },
  { status: 429, code: "invalid_grant", requiresLogin: false, diagnostic: false },
])(
  "refresh HTTP $status exposes only a safe login diagnostic",
  ({ status, code, requiresLogin, diagnostic }) =>
    Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      const error = yield* manager.getExisting.pipe(Effect.flip);
      assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
      assert.equal(error.requiresLogin, requiresLogin);
      assert.equal(error.message.includes("gustaf connect login"), requiresLogin);
      assert.equal(error.message.includes("OAuth error: invalid_grant"), diagnostic);
      assert.notInclude(error.message, "private");
      assert.equal(error.message.includes("OAuth error:"), diagnostic);
      assert.isTrue(yield* manager.hasCredential);
    }).pipe(
      provideRefreshManager(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  error: code,
                  error_description: "private-description",
                  refresh_token: "private-refresh-token",
                },
                { status },
              ),
            ),
          ),
        ),
      ),
    ),
);
