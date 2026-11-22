// @effect-diagnostics nodeBuiltinImport:off - the fake authorization server checks PKCE itself.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { McpServerId, ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpServerAuth from "./McpServerAuth.ts";

const serverUrl = "https://mcp.jam.test/mcp";
const id = McpServerId.make("jam");
const redirectUri = `http://127.0.0.1:3773${McpServerAuth.SIGN_IN_CALLBACK_PATH}`;
const decodeSettings = Schema.decodeUnknownSync(ServerSettingsSchema);

const bodyText = (body: unknown) =>
  typeof body === "object" && body !== null && "body" in body
    ? new TextDecoder().decode(body.body as Uint8Array)
    : "";

/**
 * A server that refuses without a token and points at its authorization server through the
 * challenge, as `jam` does; the authorization server registers clients and checks PKCE.
 */
type Routes = Record<string, () => Response | Effect.Effect<Response>>;

const fakeAuthorizationServer = (routes: Routes = {}) => {
  const calls: Array<string> = [];
  let challenge: string | undefined;
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.origin}${url.pathname}`;
    calls.push(route);
    const json = (value: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value, { status })));
    const form = new URLSearchParams(bodyText(request.body));
    const override = routes[route];
    if (override !== undefined) {
      const response = override();
      return (Effect.isEffect(response) ? response : Effect.succeed(response)).pipe(
        Effect.map((answer) => HttpClientResponse.fromWeb(request, answer)),
      );
    }
    switch (route) {
      case `POST ${serverUrl}`:
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, {
              status: 401,
              headers: {
                "www-authenticate":
                  'Bearer resource_metadata="https://mcp.jam.test/.well-known/oauth-protected-resource/mcp", scope="mcp:read"',
              },
            }),
          ),
        );
      case "GET https://mcp.jam.test/.well-known/oauth-protected-resource/mcp":
        return json({ resource: serverUrl, authorization_servers: ["https://auth.jam.test"] });
      case "GET https://auth.jam.test/.well-known/oauth-authorization-server":
        return json({
          authorization_endpoint: "https://auth.jam.test/authorize",
          token_endpoint: "https://auth.jam.test/token",
          registration_endpoint: "https://auth.jam.test/register",
          code_challenge_methods_supported: ["S256"],
        });
      case "POST https://auth.jam.test/register": {
        const registration = JSON.parse(bodyText(request.body)) as {
          redirect_uris: Array<string>;
        };
        assert.deepEqual(registration.redirect_uris, [redirectUri]);
        return json({ client_id: "gustaf-client" });
      }
      case "POST https://auth.jam.test/token": {
        assert.strictEqual(form.get("client_id"), "gustaf-client");
        assert.strictEqual(form.get("resource"), serverUrl);
        if (form.get("grant_type") === "authorization_code") {
          const verifier = form.get("code_verifier") ?? "";
          const expected = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
          if (form.get("code") !== "code-1" || expected !== challenge) {
            return json({ error: "invalid_grant", error_description: "bad code" }, 400);
          }
          assert.strictEqual(form.get("redirect_uri"), redirectUri);
          return json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
        }
        assert.strictEqual(form.get("grant_type"), "refresh_token");
        assert.strictEqual(form.get("refresh_token"), "refresh-1");
        // Rotation is optional; without a new refresh token the old one stays.
        return json({ access_token: "access-2", expires_in: 3600 });
      }
      default:
        return json({ error: "not_found" }, 404);
    }
  });
  return {
    client,
    calls,
    setChallenge: (value: string | null) => {
      challenge = value ?? undefined;
    },
  };
};

const jamSettings = decodeSettings({
  mcpServers: { jam: { enabled: true, transport: { type: "http", url: serverUrl } } },
});

const setup = ({
  settingsLayer = ServerSettings.layerTest(jamSettings).pipe(Layer.orDie),
  onRemove = () => Effect.void,
  onRead = () => Effect.void,
  routes = {},
  host,
}: {
  readonly settingsLayer?: Layer.Layer<ServerSettings.ServerSettingsService>;
  readonly onRemove?: (name: string) => Effect.Effect<void>;
  readonly onRead?: () => Effect.Effect<void>;
  readonly routes?: Routes;
  readonly host?: string | undefined;
} = {}) => {
  const secrets = new Map<string, Uint8Array>();
  const fake = fakeAuthorizationServer(routes);
  const layer = McpServerAuth.layer.pipe(
    Layer.provide([
      settingsLayer,
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        directory: "/secrets",
        get: (name) =>
          Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))).pipe(Effect.tap(onRead)),
        set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        remove: (name) =>
          Effect.sync(() => void secrets.delete(name)).pipe(Effect.andThen(onRemove(name))),
      }),
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          return { ...(yield* ServerConfig.ServerConfig), port: 3773, host };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-server-auth-test-" })),
        Layer.provide(NodeServices.layer),
      ),
      Layer.succeed(HttpClient.HttpClient, fake.client),
      FileSystem.layerNoop({
        readDirectory: (directory) =>
          Effect.sync(() =>
            directory === "/secrets"
              ? [...secrets.keys()].map((name) => `${name}.bin`).concat("unrelated.bin")
              : [],
          ),
      }),
      NodePlatformCrypto.layer,
    ]),
  );
  return { secrets, fake, layer };
};

it.effect.each([undefined, "100.64.0.7"])(
  "signs in through discovered metadata with PKCE and refreshes before expiry (host %s)",
  (host) => {
    // The code comes back over plain http, so it never leaves this machine.
    const { secrets, fake, layer } = setup({ host });
    return Effect.gen(function* () {
      const auth = yield* McpServerAuth.McpServerAuth;
      const started = yield* auth.signIn({ id });
      const authUrl = new URL(started.authUrl);
      assert.strictEqual(started.redirectUri, redirectUri);
      assert.strictEqual(`${authUrl.origin}${authUrl.pathname}`, "https://auth.jam.test/authorize");
      assert.deepEqual(
        Object.fromEntries(
          [
            "response_type",
            "client_id",
            "redirect_uri",
            "code_challenge_method",
            "resource",
            "scope",
          ].map((key) => [key, authUrl.searchParams.get(key)]),
        ),
        {
          response_type: "code",
          client_id: "gustaf-client",
          redirect_uri: redirectUri,
          code_challenge_method: "S256",
          resource: serverUrl,
          scope: "mcp:read",
        },
      );
      fake.setChallenge(authUrl.searchParams.get("code_challenge"));
      const callback = `${redirectUri}?code=code-1&state=${authUrl.searchParams.get("state")}`;

      assert.strictEqual(yield* auth.revision(id), 0);
      assert.deepEqual(yield* auth.completeSignIn({ callbackUrl: callback }), { id });
      assert.strictEqual(yield* auth.revision(id), 1);
      assert.isTrue(yield* auth.isSignedIn(id, serverUrl));
      assert.strictEqual(yield* auth.accessToken(id, serverUrl), "access-1");
      // A token never follows a server whose URL was edited.
      assert.isUndefined(yield* auth.accessToken(id, "https://elsewhere.test/mcp"));
      // The state is spent: the same address cannot sign in twice.
      assert.strictEqual(
        (yield* auth.completeSignIn({ callbackUrl: callback }).pipe(Effect.flip))._tag,
        "McpServerAuthError",
      );

      yield* TestClock.adjust("3570 seconds");
      assert.strictEqual(yield* auth.accessToken(id, serverUrl), "access-2");
      assert.strictEqual(yield* auth.accessToken(id, serverUrl), "access-2");
      assert.strictEqual(
        fake.calls.filter((call) => call === "POST https://auth.jam.test/token").length,
        2,
      );
      const stored = JSON.parse(new TextDecoder().decode([...secrets.values()][0]));
      assert.strictEqual(stored.refreshToken, "refresh-1");
      assert.strictEqual(stored.accessToken, "access-2");
    }).pipe(Effect.provide(layer));
  },
);

it.effect("signing out deletes the stored token and cancels a pending callback", () => {
  const { secrets, fake, layer } = setup();
  return Effect.gen(function* () {
    const auth = yield* McpServerAuth.McpServerAuth;
    const authUrl = new URL((yield* auth.signIn({ id })).authUrl);
    fake.setChallenge(authUrl.searchParams.get("code_challenge"));
    yield* auth.completeSignIn({
      callbackUrl: `${redirectUri}?code=code-1&state=${authUrl.searchParams.get("state")}`,
    });
    assert.strictEqual(secrets.size, 1);

    const pending = new URL((yield* auth.signIn({ id })).authUrl);
    fake.setChallenge(pending.searchParams.get("code_challenge"));

    yield* auth.signOut({ id });
    assert.strictEqual(secrets.size, 0);
    assert.isFalse(yield* auth.isSignedIn(id, serverUrl));
    assert.isUndefined(yield* auth.accessToken(id, serverUrl));
    assert.strictEqual(yield* auth.revision(id), 2);
    const error = yield* auth
      .completeSignIn({
        callbackUrl: `${redirectUri}?code=code-1&state=${pending.searchParams.get("state")}`,
      })
      .pipe(Effect.flip);
    assert.include(error.detail, "expired");
    assert.strictEqual(secrets.size, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("signing out before registration finishes cancels that sign-in", () =>
  Effect.gen(function* () {
    const registering = yield* Deferred.make<void>();
    const registration = yield* Deferred.make<Response>();
    const { layer } = setup({
      routes: {
        "POST https://auth.jam.test/register": () =>
          Deferred.succeed(registering, undefined).pipe(
            Effect.andThen(Deferred.await(registration)),
          ),
      },
    });
    yield* Effect.gen(function* () {
      const auth = yield* McpServerAuth.McpServerAuth;
      const starting = yield* auth.signIn({ id }).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(registering);
      yield* auth.signOut({ id });
      yield* Deferred.succeed(registration, Response.json({ client_id: "gustaf-client" }));
      assert.include((yield* Fiber.join(starting)).detail, "changed while it was being started");
      assert.isFalse(yield* auth.isSignedIn(id, serverUrl));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("removing a server from settings deletes its sign-in", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<ServerSettingsSchema>();
    const removed = yield* Deferred.make<string>();
    const { secrets, fake, layer } = setup({
      settingsLayer: Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(jamSettings),
        subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
      }),
      onRemove: (name) => Deferred.succeed(removed, name).pipe(Effect.asVoid),
    });
    yield* Effect.gen(function* () {
      const auth = yield* McpServerAuth.McpServerAuth;
      const authUrl = new URL((yield* auth.signIn({ id })).authUrl);
      fake.setChallenge(authUrl.searchParams.get("code_challenge"));
      yield* auth.completeSignIn({
        callbackUrl: `${redirectUri}?code=code-1&state=${authUrl.searchParams.get("state")}`,
      });
      const [secretName] = [...secrets.keys()];

      yield* Queue.offer(changes, { ...jamSettings, mcpServers: {} });
      assert.strictEqual(yield* Deferred.await(removed), secretName);
      assert.strictEqual(secrets.size, 0);
    }).pipe(Effect.provide(layer));
  }),
);

const challenging = (metadataUrl: string) => () =>
  new Response(null, {
    status: 401,
    headers: { "www-authenticate": `Bearer resource_metadata="${metadataUrl}"` },
  });

it.effect.each([
  {
    name: "metadata naming another server's resource",
    url: "https://evil.test/mcp",
    routes: {
      "POST https://evil.test/mcp": challenging(
        "https://evil.test/.well-known/oauth-protected-resource/mcp",
      ),
      "GET https://evil.test/.well-known/oauth-protected-resource/mcp": () =>
        Response.json({ resource: serverUrl, authorization_servers: ["https://auth.jam.test"] }),
    },
    detail: "another resource",
  },
  {
    name: "authorization server metadata naming another issuer",
    url: serverUrl,
    routes: {
      "GET https://auth.jam.test/.well-known/oauth-authorization-server": () =>
        Response.json({
          issuer: "https://auth.evil.test",
          authorization_endpoint: "https://auth.jam.test/authorize",
          token_endpoint: "https://auth.jam.test/token",
          registration_endpoint: "https://auth.jam.test/register",
        }),
    },
    detail: "another issuer",
  },
  {
    name: "a token endpoint without https",
    url: serverUrl,
    routes: {
      "GET https://auth.jam.test/.well-known/oauth-authorization-server": () =>
        Response.json({
          authorization_endpoint: "https://auth.jam.test/authorize",
          token_endpoint: "http://auth.jam.test/token",
          registration_endpoint: "https://auth.jam.test/register",
        }),
    },
    detail: "https",
  },
])("refuses to sign in through $name", ({ url, routes, detail }) => {
  const { secrets, fake, layer } = setup({
    settingsLayer: ServerSettings.layerTest(
      decodeSettings({
        mcpServers: { jam: { enabled: true, transport: { type: "http", url } } },
      }),
    ).pipe(Layer.orDie),
    routes,
  });
  return Effect.gen(function* () {
    const auth = yield* McpServerAuth.McpServerAuth;
    const error = yield* auth.signIn({ id }).pipe(Effect.flip);
    assert.include(error.detail, detail);
    assert.notInclude(fake.calls, "POST https://auth.jam.test/register");
    assert.strictEqual(secrets.size, 0);
  }).pipe(Effect.provide(layer));
});

/** A stored sign-in whose token has expired, as `completeSignIn` would have saved it. */
const storeExpiredLogin = (
  secrets: Map<string, Uint8Array>,
  serverId: McpServerId,
  tokenEndpoint: string,
) =>
  secrets.set(
    `mcp-server-oauth-${base64UrlEncode(serverId)}`,
    new TextEncoder().encode(
      JSON.stringify({
        tokenEndpoint,
        resource: serverUrl,
        clientId: "gustaf-client",
        clientAuth: "none",
        serverUrl,
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: 0,
      }),
    ),
  );

it.effect("a hung authorization server delays neither another server nor past its timeout", () => {
  const { secrets, layer } = setup({
    settingsLayer: ServerSettings.layerTest(
      decodeSettings({
        mcpServers: {
          jam: { enabled: true, transport: { type: "http", url: serverUrl } },
          hung: { enabled: true, transport: { type: "http", url: serverUrl } },
        },
      }),
    ).pipe(Layer.orDie),
    routes: { "POST https://auth.hung.test/token": () => Effect.never },
  });
  const hung = McpServerId.make("hung");
  storeExpiredLogin(secrets, hung, "https://auth.hung.test/token");
  storeExpiredLogin(secrets, id, "https://auth.jam.test/token");
  return Effect.gen(function* () {
    const auth = yield* McpServerAuth.McpServerAuth;
    const waiting = yield* auth.accessToken(hung, serverUrl).pipe(Effect.forkChild);
    assert.strictEqual(yield* auth.accessToken(id, serverUrl), "access-2");

    yield* TestClock.adjust("10 seconds");
    assert.isUndefined(yield* Fiber.join(waiting));
  }).pipe(Effect.provide(layer));
});

it.effect.each([true, false])(
  "signing out during a token refresh leaves no token (refresh succeeds: %s)",
  (succeeds) =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      const { secrets, layer } = setup({
        routes: {
          "POST https://auth.jam.test/token": () =>
            Deferred.succeed(requested, undefined).pipe(
              Effect.andThen(Deferred.await(answer)),
              Effect.as(
                succeeds
                  ? Response.json({ access_token: "access-2", expires_in: 3600 })
                  : Response.json({ error: "invalid_grant" }, { status: 400 }),
              ),
            ),
        },
      });
      storeExpiredLogin(secrets, id, "https://auth.jam.test/token");
      yield* Effect.gen(function* () {
        const auth = yield* McpServerAuth.McpServerAuth;
        const refreshing = yield* auth.accessToken(id, serverUrl).pipe(Effect.forkChild);
        yield* Deferred.await(requested);
        yield* auth.signOut({ id });
        yield* Deferred.succeed(answer, undefined);

        assert.isUndefined(yield* Fiber.join(refreshing));
        assert.strictEqual(secrets.size, 0);
        assert.isFalse(yield* auth.isSignedIn(id, serverUrl));
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("signing out while reading the stored login never brings it back", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    const answer = yield* Deferred.make<void>();
    const { secrets, layer } = setup({
      onRead: () =>
        Deferred.succeed(requested, undefined).pipe(Effect.andThen(Deferred.await(answer))),
    });
    storeExpiredLogin(secrets, id, "https://auth.jam.test/token");
    yield* Effect.gen(function* () {
      const auth = yield* McpServerAuth.McpServerAuth;
      const reading = yield* auth.accessToken(id, serverUrl).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* auth.signOut({ id });
      yield* Deferred.succeed(answer, undefined);

      assert.isUndefined(yield* Fiber.join(reading));
      assert.strictEqual(secrets.size, 0);
      assert.isFalse(yield* auth.isSignedIn(id, serverUrl));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("drops sign-ins of servers removed while the environment was off, and only those", () =>
  Effect.gen(function* () {
    const removed = yield* Deferred.make<string>();
    const { secrets, layer } = setup({
      onRemove: (name) => Deferred.succeed(removed, name).pipe(Effect.asVoid),
    });
    storeExpiredLogin(secrets, id, "https://auth.jam.test/token");
    storeExpiredLogin(secrets, McpServerId.make("gone"), "https://auth.jam.test/token");
    yield* Effect.gen(function* () {
      yield* McpServerAuth.McpServerAuth;
      assert.strictEqual(
        yield* Deferred.await(removed),
        `mcp-server-oauth-${base64UrlEncode("gone")}`,
      );
      assert.deepEqual([...secrets.keys()], [`mcp-server-oauth-${base64UrlEncode(id)}`]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "the callback page finishes a sign-in and reports a refused or unknown one as text",
  () => {
    const { fake, layer } = setup();
    return Effect.gen(function* () {
      const auth = yield* McpServerAuth.McpServerAuth;
      const context = yield* Effect.context<McpServerAuth.McpServerAuth>();
      const page = (query: string) =>
        Effect.acquireUseRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              McpServerAuth.callbackRouteLayer.pipe(Layer.provideMerge(NodeServices.layer)),
              { disableLogger: true },
            ),
          ),
          (web) =>
            Effect.promise(() =>
              web
                .handler(new Request(`${redirectUri}?${query}`), context)
                .then(async (response) => `${response.status} ${await response.text()}`),
            ),
          (web) => Effect.promise(() => web.dispose()),
        );
      const startState = Effect.gen(function* () {
        const authUrl = new URL((yield* auth.signIn({ id })).authUrl);
        fake.setChallenge(authUrl.searchParams.get("code_challenge"));
        return authUrl.searchParams.get("state")!;
      });

      const unknown = yield* page("code=code-1&state=made-up");
      assert.include(unknown, "expired or was started elsewhere");

      const refused = yield* page(
        new URLSearchParams({
          state: yield* startState,
          error: "access_denied",
          error_description: '<img src=x onerror="alert(1)">',
        }).toString(),
      );
      assert.include(refused, "Sign-in was refused: img src=x onerror=alert(1)");
      assert.notInclude(refused, "<img");
      assert.isFalse(yield* auth.isSignedIn(id, serverUrl));

      const signedIn = yield* page(`code=code-1&state=${yield* startState}`);
      assert.include(signedIn, "Signed in");
      assert.isTrue(yield* auth.isSignedIn(id, serverUrl));
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a sign-in not finished within 10 minutes has to start again", () => {
  const { fake, layer } = setup();
  return Effect.gen(function* () {
    const auth = yield* McpServerAuth.McpServerAuth;
    const authUrl = new URL((yield* auth.signIn({ id })).authUrl);
    fake.setChallenge(authUrl.searchParams.get("code_challenge"));
    yield* TestClock.adjust("10 minutes");
    const error = yield* auth
      .completeSignIn({
        callbackUrl: `${redirectUri}?code=code-1&state=${authUrl.searchParams.get("state")}`,
      })
      .pipe(Effect.flip);
    assert.include(error.detail, "expired");
    assert.isFalse(yield* auth.isSignedIn(id, serverUrl));
  }).pipe(Effect.provide(layer));
});

it.effect(
  "a refused refresh keeps the sign-in for retry without returning an expired token",
  () => {
    let refusals = 0;
    const { secrets, layer } = setup({
      routes: {
        "POST https://auth.jam.test/token": () => {
          refusals += 1;
          return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        },
      },
    });
    storeExpiredLogin(secrets, id, "https://auth.jam.test/token");
    const stored = [...secrets.values()][0];
    return Effect.gen(function* () {
      const auth = yield* McpServerAuth.McpServerAuth;
      assert.isUndefined(yield* auth.accessToken(id, serverUrl));
      assert.strictEqual([...secrets.values()][0], stored);
      assert.isUndefined(yield* auth.accessToken(id, serverUrl));
      assert.deepEqual(yield* auth.tokenState(id, serverUrl), {
        token: undefined,
        refreshDue: true,
      });
      assert.strictEqual(refusals, 2);
    }).pipe(Effect.provide(layer));
  },
);
