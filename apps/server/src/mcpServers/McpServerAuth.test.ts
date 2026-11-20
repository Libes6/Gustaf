// @effect-diagnostics nodeBuiltinImport:off - the fake authorization server checks PKCE itself.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { McpServerId, ServerSettings as ServerSettingsSchema } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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
const fakeAuthorizationServer = () => {
  const calls: Array<string> = [];
  let challenge: string | undefined;
  const client = HttpClient.make((request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.origin}${url.pathname}`);
    const json = (value: unknown, status = 200) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(value, { status })));
    const form = new URLSearchParams(bodyText(request.body));
    switch (`${request.method} ${url.origin}${url.pathname}`) {
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

const setup = (
  settingsLayer: Layer.Layer<ServerSettings.ServerSettingsService> = ServerSettings.layerTest(
    jamSettings,
  ).pipe(Layer.orDie),
  onRemove: (name: string) => Effect.Effect<void> = () => Effect.void,
) => {
  const secrets = new Map<string, Uint8Array>();
  const fake = fakeAuthorizationServer();
  const layer = McpServerAuth.layer.pipe(
    Layer.provide([
      settingsLayer,
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
        set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        remove: (name) =>
          Effect.sync(() => void secrets.delete(name)).pipe(Effect.andThen(onRemove(name))),
      }),
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          return { ...(yield* ServerConfig.ServerConfig), port: 3773 };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-server-auth-test-" })),
        Layer.provide(NodeServices.layer),
      ),
      Layer.succeed(HttpClient.HttpClient, fake.client),
      NodePlatformCrypto.layer,
    ]),
  );
  return { secrets, fake, layer };
};

it.effect("signs in through discovered metadata with PKCE and refreshes before expiry", () => {
  const { secrets, fake, layer } = setup();
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
});

it.effect("signing out deletes the stored token", () => {
  const { secrets, fake, layer } = setup();
  return Effect.gen(function* () {
    const auth = yield* McpServerAuth.McpServerAuth;
    const authUrl = new URL((yield* auth.signIn({ id })).authUrl);
    fake.setChallenge(authUrl.searchParams.get("code_challenge"));
    yield* auth.completeSignIn({
      callbackUrl: `${redirectUri}?code=code-1&state=${authUrl.searchParams.get("state")}`,
    });
    assert.strictEqual(secrets.size, 1);

    yield* auth.signOut({ id });
    assert.strictEqual(secrets.size, 0);
    assert.isFalse(yield* auth.isSignedIn(id, serverUrl));
    assert.isUndefined(yield* auth.accessToken(id, serverUrl));
    assert.strictEqual(yield* auth.revision(id), 2);
  }).pipe(Effect.provide(layer));
});

it.effect("removing a server from settings deletes its sign-in", () =>
  Effect.gen(function* () {
    const changes = yield* Queue.unbounded<ServerSettingsSchema>();
    const removed = yield* Deferred.make<string>();
    const { secrets, fake, layer } = setup(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(jamSettings),
        subscribeChanges: Effect.succeed(Stream.fromQueue(changes)),
      }),
      (name) => Deferred.succeed(removed, name).pipe(Effect.asVoid),
    );
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
