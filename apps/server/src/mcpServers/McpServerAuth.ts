import {
  McpServerAuthError,
  type McpServerConfig,
  type McpServerId,
  type McpServerSignInCallbackInput,
  type McpServerSignInCallbackResult,
  type McpServerSignInInput,
  type McpServerSignInResult,
  type McpServerSignOutInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode, loopbackBindAddress } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";

/** The environment's own route the authorization server sends the browser back to. */
export const SIGN_IN_CALLBACK_PATH = "/mcp-oauth/callback";
const SIGN_IN_TTL_MS = 10 * 60_000;
// A token this close to expiry is refreshed before a provider gets it.
const REFRESH_MARGIN_MS = 60_000;
const PROTOCOL_VERSION = "2025-06-18";
// Sessions open and status checks wait on these calls; undici alone would wait 5 minutes.
const OAUTH_TIMEOUT = Duration.seconds(10);

/**
 * Signs in to the user's http MCP servers over OAuth (MCP Authorization: protected resource
 * metadata, dynamic client registration, PKCE) and keeps the tokens in the environment's secret
 * store, so every provider is sent the same `Authorization` header.
 */
export class McpServerAuth extends Context.Service<
  McpServerAuth,
  {
    /** The server's bearer token, refreshed first when it is about to expire or `force` is set. */
    readonly accessToken: (
      id: McpServerId,
      url: string,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<string | undefined>;
    readonly isSignedIn: (id: McpServerId, url: string) => Effect.Effect<boolean>;
    /** Changes whenever signing in or out changes what the server is sent. */
    readonly revision: (id: McpServerId) => Effect.Effect<number>;
    readonly signIn: (
      input: McpServerSignInInput,
    ) => Effect.Effect<McpServerSignInResult, McpServerAuthError>;
    /** Finishes a sign-in from the address the browser was sent back to. */
    readonly completeSignIn: (
      input: McpServerSignInCallbackInput,
    ) => Effect.Effect<McpServerSignInCallbackResult, McpServerAuthError>;
    readonly signOut: (input: McpServerSignOutInput) => Effect.Effect<void, McpServerAuthError>;
  }
>()("t3/mcpServers/McpServerAuth") {}

const ClientAuthMethod = Schema.Literals(["none", "client_secret_post", "client_secret_basic"]);
type ClientAuthMethod = typeof ClientAuthMethod.Type;

const Client = Schema.Struct({
  tokenEndpoint: Schema.String,
  resource: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
  clientAuth: ClientAuthMethod,
});
type Client = typeof Client.Type;

/** One server's sign-in as stored; `serverUrl` keeps a token from following an edited URL. */
const Login = Schema.Struct({
  ...Client.fields,
  serverUrl: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.Number),
});
type Login = typeof Login.Type;
const LoginJson = Schema.fromJsonString(Login);
const decodeLogin = Schema.decodeUnknownOption(LoginJson);
const encodeLogin = Schema.encodeSync(LoginJson);

const ProtectedResource = Schema.Struct({
  resource: Schema.optional(Schema.String),
  authorization_servers: Schema.optional(Schema.Array(Schema.String)),
  scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});
const AuthorizationServer = Schema.Struct({
  issuer: Schema.optional(Schema.String),
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
});
const Registration = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
});
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});
const OAuthErrorBody = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});
const decodeProtectedResource = Schema.decodeUnknownEffect(ProtectedResource);
const decodeAuthorizationServer = Schema.decodeUnknownEffect(AuthorizationServer);
const decodeRegistration = Schema.decodeUnknownEffect(Registration);
const decodeTokenResponse = Schema.decodeUnknownEffect(TokenResponse);
const decodeOAuthError = Schema.decodeUnknownOption(OAuthErrorBody);

const authError = (detail: string) => new McpServerAuthError({ detail });

const withOAuthTimeout = <A, R>(effect: Effect.Effect<A, McpServerAuthError, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: OAUTH_TIMEOUT,
      orElse: () =>
        Effect.fail(
          authError(
            `The server did not answer in ${Duration.toSeconds(OAUTH_TIMEOUT)} seconds. Try again later.`,
          ),
        ),
    }),
  );

const secretName = (id: McpServerId) => `mcp-server-oauth-${base64UrlEncode(id)}`;

const header = (response: HttpClientResponse.HttpClientResponse, name: string) =>
  response.headers[name];

/** A `key="value"` parameter of a `WWW-Authenticate: Bearer …` challenge. */
const challengeParam = (challenge: string | undefined, key: string) =>
  challenge?.match(new RegExp(`${key}="([^"]*)"`))?.[1];

/** RFC 8414 and OpenID Connect locations for an issuer, path-inserted first. */
export const authorizationServerMetadataUrls = (issuer: string) => {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  return path === ""
    ? [
        `${url.origin}/.well-known/oauth-authorization-server`,
        `${url.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`,
      ];
};

const protectedResourceMetadataUrls = (serverUrl: string, fromChallenge: string | undefined) => {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, "");
  return [
    ...(fromChallenge === undefined ? [] : [fromChallenge]),
    ...(path === "" ? [] : [`${url.origin}/.well-known/oauth-protected-resource${path}`]),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ];
};

/** OAuth addresses carry codes and tokens, so they must be https unless they stay on this machine. */
const isSecureEndpoint = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && loopbackBindAddress(url.hostname) !== undefined)
  );
};

/**
 * RFC 9728 §3.3: resource metadata must describe the server it was fetched for. As the MCP SDK
 * does, the named resource may be the server's URL or a path above it on the same origin.
 */
const coversServer = (resource: string, serverUrl: string) => {
  if (!URL.canParse(resource)) return false;
  const named = new URL(resource);
  const server = new URL(serverUrl);
  const withSlash = (path: string) => (path.endsWith("/") ? path : `${path}/`);
  return (
    named.origin === server.origin &&
    withSlash(server.pathname).startsWith(withSlash(named.pathname))
  );
};

// RFC 8414 §3.3; a trailing slash is the only difference tolerated.
const sameIssuer = (left: string, right: string) =>
  left.replace(/\/+$/, "") === right.replace(/\/+$/, "");

const callbackPage = (title: string, body: string) =>
  HttpServerResponse.html(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`,
  );

interface PendingSignIn {
  readonly id: McpServerId;
  readonly serverUrl: string;
  readonly client: Client;
  readonly redirectUri: string;
  readonly verifier: string;
  readonly expiresAt: number;
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;
  const digester = yield* Digest.Digest;
  const serviceScope = yield* Effect.scope;

  // Logins read from the secret store; `null` is a server known to have none.
  const logins = new Map<McpServerId, Login | null>();
  const revisions = new Map<McpServerId, number>();
  const pending = new Map<string, PendingSignIn>();
  // One refresh per server at a time; others join it, and other servers never wait on it.
  const refreshing = new Map<McpServerId, Deferred.Deferred<string>>();

  const bump = (id: McpServerId) => revisions.set(id, (revisions.get(id) ?? 0) + 1);

  const randomToken = random.randomBytes(32).pipe(Effect.map(base64UrlEncode));

  const loginOf = Effect.fnUntraced(function* (id: McpServerId) {
    const cached = logins.get(id);
    if (cached !== undefined) return cached ?? undefined;
    const stored = yield* secretStore.get(secretName(id)).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("MCP server sign-in could not be read", { mcpServerId: id, cause }),
      ),
      Effect.option,
      Effect.map(Option.flatten),
    );
    const login = Option.isSome(stored)
      ? Option.getOrUndefined(decodeLogin(new TextDecoder().decode(stored.value)))
      : undefined;
    logins.set(id, login ?? null);
    return login;
  });

  const store = Effect.fnUntraced(function* (id: McpServerId, login: Login) {
    yield* secretStore
      .set(secretName(id), new TextEncoder().encode(encodeLogin(login)))
      .pipe(
        Effect.mapError(() => authError("The sign-in could not be saved on this environment.")),
      );
    logins.set(id, login);
  });

  const getJson = Effect.fnUntraced(function* <A, E>(
    decode: (input: unknown) => Effect.Effect<A, E>,
    url: string,
  ) {
    const response = yield* httpClient
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson))
      .pipe(Effect.option);
    if (Option.isNone(response) || response.value.status < 200 || response.value.status >= 300) {
      return Option.none<A>();
    }
    return yield* response.value.json.pipe(Effect.flatMap(decode), Effect.option);
  });

  /** Posts a form to the token endpoint; an OAuth error answer becomes its description. */
  const tokenRequest = Effect.fnUntraced(function* (
    client: Client,
    params: Record<string, string>,
  ) {
    const body: Record<string, string> = { ...params, resource: client.resource };
    if (client.clientAuth !== "client_secret_basic") body.client_id = client.clientId;
    if (client.clientAuth === "client_secret_post" && client.clientSecret !== undefined) {
      body.client_secret = client.clientSecret;
    }
    let request = HttpClientRequest.post(client.tokenEndpoint).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUrlParams(body),
    );
    if (client.clientAuth === "client_secret_basic") {
      request = HttpClientRequest.basicAuth(request, client.clientId, client.clientSecret ?? "");
    }
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.mapError(() => authError("The authorization server could not be reached.")));
    const json = yield* response.json.pipe(
      Effect.mapError(() =>
        authError(`The authorization server answered HTTP ${response.status}.`),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const failure = decodeOAuthError(json);
      return yield* authError(
        Option.isSome(failure)
          ? `The authorization server refused: ${failure.value.error_description ?? failure.value.error}`
          : `The authorization server answered HTTP ${response.status}.`,
      );
    }
    return yield* decodeTokenResponse(json).pipe(
      Effect.mapError(() => authError("The authorization server sent no access token.")),
    );
  }, withOAuthTimeout);

  const toLogin = Effect.fnUntraced(function* (
    serverUrl: string,
    client: Client,
    tokens: typeof TokenResponse.Type,
    previousRefreshToken?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const refreshToken = tokens.refresh_token ?? previousRefreshToken;
    return {
      ...client,
      serverUrl,
      accessToken: tokens.access_token,
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(tokens.expires_in === undefined ? {} : { expiresAt: now + tokens.expires_in * 1000 }),
    } satisfies Login;
  });

  const refresh = Effect.fnUntraced(function* (id: McpServerId, login: Login) {
    if (login.refreshToken === undefined) return login;
    const tokens = yield* tokenRequest(login, {
      grant_type: "refresh_token",
      refresh_token: login.refreshToken,
    });
    const next = yield* toLogin(login.serverUrl, login, tokens, login.refreshToken);
    yield* store(id, next);
    return next;
  });

  const accessToken: McpServerAuth["Service"]["accessToken"] = Effect.fn(
    "McpServerAuth.accessToken",
  )(function* (id, url, options) {
    const login = yield* loginOf(id);
    if (login === undefined || login.serverUrl !== url) return undefined;
    const now = yield* Clock.currentTimeMillis;
    const stale =
      options?.force === true ||
      (login.expiresAt !== undefined && login.expiresAt - REFRESH_MARGIN_MS <= now);
    if (!stale || login.refreshToken === undefined) return login.accessToken;
    const inFlight = refreshing.get(id);
    if (inFlight !== undefined) return yield* Deferred.await(inFlight);
    const refreshed = Deferred.makeUnsafe<string>();
    refreshing.set(id, refreshed);
    // Forked so a caller that gives up does not leave the others waiting.
    yield* refresh(id, login).pipe(
      Effect.tapError((error) =>
        Effect.logWarning("MCP server token could not be refreshed", {
          mcpServerId: id,
          detail: error.detail,
        }),
      ),
      Effect.orElseSucceed(() => login),
      Effect.flatMap((next) => Deferred.succeed(refreshed, next.accessToken)),
      Effect.ensuring(
        Effect.sync(() => refreshing.delete(id)).pipe(
          Effect.andThen(Deferred.succeed(refreshed, login.accessToken)),
        ),
      ),
      Effect.forkIn(serviceScope),
    );
    return yield* Deferred.await(refreshed);
  });

  const httpServer = Effect.fnUntraced(function* (id: McpServerId) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => authError("The MCP servers could not be read.")),
    );
    const server: McpServerConfig | undefined = current.mcpServers[id];
    if (server === undefined) return yield* authError(`MCP server "${id}" does not exist.`);
    if (server.transport.type !== "http") {
      return yield* authError(`MCP server "${id}" is not an http server.`);
    }
    return server.transport.url;
  });

  // Always this machine, even when the server listens on a LAN or tailnet address: the code comes
  // back over plain http. Another device pastes the address it landed on instead.
  const redirectUri = () => {
    const host = loopbackBindAddress(config.host) ?? "127.0.0.1";
    const hostname = host.includes(":") ? `[${host}]` : host;
    return `http://${hostname}:${config.port}${SIGN_IN_CALLBACK_PATH}`;
  };

  const discover = Effect.fnUntraced(function* (serverUrl: string) {
    // An unauthenticated request names the protected resource metadata in its challenge.
    const probe = yield* httpClient
      .execute(
        HttpClientRequest.post(serverUrl).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json, text/event-stream" }),
          HttpClientRequest.bodyJsonUnsafe({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "gustaf", version: "1" },
            },
          }),
        ),
      )
      .pipe(Effect.mapError(() => authError("The MCP server could not be reached.")));
    const challenge = header(probe, "www-authenticate");
    let resource: typeof ProtectedResource.Type | undefined;
    for (const url of protectedResourceMetadataUrls(
      serverUrl,
      challengeParam(challenge, "resource_metadata"),
    )) {
      if (!isSecureEndpoint(url)) continue;
      const found = yield* getJson(decodeProtectedResource, url);
      if (Option.isSome(found)) {
        resource = found.value;
        break;
      }
    }
    if (resource?.resource !== undefined && !coversServer(resource.resource, serverUrl)) {
      return yield* authError(
        "The server's sign-in metadata names another resource, so Gustaf did not sign in. Check the server's URL.",
      );
    }
    // Servers on the 2025-03-26 spec have no resource metadata and authorize on their own origin.
    const issuer = resource?.authorization_servers?.[0] ?? new URL(serverUrl).origin;
    if (!isSecureEndpoint(issuer)) {
      return yield* authError(
        "The authorization server's address is not https, so Gustaf did not sign in.",
      );
    }
    let metadata: typeof AuthorizationServer.Type | undefined;
    for (const url of authorizationServerMetadataUrls(issuer)) {
      const found = yield* getJson(decodeAuthorizationServer, url);
      if (Option.isSome(found)) {
        metadata = found.value;
        break;
      }
    }
    if (metadata?.issuer !== undefined && !sameIssuer(metadata.issuer, issuer)) {
      return yield* authError(
        "The authorization server's metadata names another issuer, so Gustaf did not sign in.",
      );
    }
    if (metadata === undefined) {
      if (resource === undefined && probe.status !== 401) {
        return yield* authError("This MCP server does not ask for sign-in.");
      }
      const origin = new URL(issuer).origin;
      metadata = {
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      };
    }
    // The client opens the authorization address in a browser; the others get codes and tokens.
    const endpoints = [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      ...(metadata.registration_endpoint === undefined ? [] : [metadata.registration_endpoint]),
    ];
    if (!endpoints.every(isSecureEndpoint)) {
      return yield* authError(
        "The authorization server sent an address that is not https, so Gustaf did not sign in.",
      );
    }
    const methods = metadata.code_challenge_methods_supported;
    if (methods !== undefined && !methods.includes("S256")) {
      return yield* authError("The authorization server does not support PKCE (S256).");
    }
    const scope =
      challengeParam(challenge, "scope") ?? resource?.scopes_supported?.join(" ") ?? undefined;
    return {
      metadata,
      resource: resource?.resource ?? serverUrl,
      ...(scope === undefined || scope === "" ? {} : { scope }),
    };
  }, withOAuthTimeout);

  const register = Effect.fnUntraced(function* (registrationEndpoint: string, redirect: string) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(registrationEndpoint).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({
            client_name: "Gustaf",
            redirect_uris: [redirect],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        ),
      )
      .pipe(Effect.mapError(() => authError("The authorization server could not be reached.")));
    if (response.status < 200 || response.status >= 300) {
      return yield* authError(
        `The authorization server refused to register Gustaf (HTTP ${response.status}).`,
      );
    }
    const registration = yield* response.json.pipe(
      Effect.flatMap(decodeRegistration),
      Effect.mapError(() => authError("The authorization server sent an invalid registration.")),
    );
    const method = registration.token_endpoint_auth_method;
    const clientAuth: ClientAuthMethod =
      registration.client_secret === undefined
        ? "none"
        : method === "client_secret_basic"
          ? "client_secret_basic"
          : "client_secret_post";
    return {
      clientId: registration.client_id,
      ...(registration.client_secret === undefined
        ? {}
        : { clientSecret: registration.client_secret }),
      clientAuth,
    };
  }, withOAuthTimeout);

  const signIn: McpServerAuth["Service"]["signIn"] = Effect.fn("McpServerAuth.signIn")(function* ({
    id,
  }) {
    const serverUrl = yield* httpServer(id);
    const { metadata, resource, scope } = yield* discover(serverUrl);
    if (metadata.registration_endpoint === undefined) {
      return yield* authError(
        "The authorization server does not let Gustaf register itself, so it cannot sign in.",
      );
    }
    const redirect = redirectUri();
    const registered = yield* register(metadata.registration_endpoint, redirect);
    const verifier = yield* randomToken;
    const state = yield* randomToken;
    const challenge = yield* digester
      .digest(Digest.sha256, new TextEncoder().encode(verifier))
      .pipe(Effect.orDie, Effect.map(base64UrlEncode));
    const now = yield* Clock.currentTimeMillis;
    for (const [key, entry] of pending) {
      if (entry.expiresAt <= now || entry.id === id) pending.delete(key);
    }
    pending.set(state, {
      id,
      serverUrl,
      client: { ...registered, tokenEndpoint: metadata.token_endpoint, resource },
      redirectUri: redirect,
      verifier,
      expiresAt: now + SIGN_IN_TTL_MS,
    });
    const authUrl = new URL(metadata.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", registered.clientId);
    authUrl.searchParams.set("redirect_uri", redirect);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("resource", resource);
    if (scope !== undefined) authUrl.searchParams.set("scope", scope);
    return { authUrl: authUrl.toString(), redirectUri: redirect };
  });

  const completeSignIn: McpServerAuth["Service"]["completeSignIn"] = Effect.fn(
    "McpServerAuth.completeSignIn",
  )(function* ({ callbackUrl }) {
    const url = yield* Effect.try({
      try: () => new URL(callbackUrl),
      catch: () => authError("Paste the whole address the browser opened after signing in."),
    });
    const state = url.searchParams.get("state");
    const flow = state === null ? undefined : pending.get(state);
    const now = yield* Clock.currentTimeMillis;
    if (state === null || flow === undefined || flow.expiresAt <= now) {
      return yield* authError("This sign-in has expired or was started elsewhere. Sign in again.");
    }
    pending.delete(state);
    const refused = url.searchParams.get("error");
    if (refused !== null) {
      return yield* authError(
        `Sign-in was refused: ${url.searchParams.get("error_description") ?? refused}`,
      );
    }
    const code = url.searchParams.get("code");
    if (code === null) return yield* authError("The address has no authorization code.");
    const tokens = yield* tokenRequest(flow.client, {
      grant_type: "authorization_code",
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    yield* store(flow.id, yield* toLogin(flow.serverUrl, flow.client, tokens));
    bump(flow.id);
    return { id: flow.id };
  });

  const signOut: McpServerAuth["Service"]["signOut"] = Effect.fn("McpServerAuth.signOut")(
    function* ({ id }) {
      yield* secretStore
        .remove(secretName(id))
        .pipe(Effect.mapError(() => authError("The sign-in could not be removed.")));
      logins.set(id, null);
      bump(id);
    },
  );

  // Whatever removes a server from settings (a client, an agent, a pasted file) drops its sign-in.
  const changes = yield* settings.subscribeChanges;
  let knownIds = new Set(
    Object.keys(
      yield* settings.getSettings.pipe(
        Effect.map((current) => current.mcpServers),
        Effect.orElseSucceed(() => ({})),
      ),
    ) as Array<McpServerId>,
  );
  yield* forkParked(
    Stream.runForEach(changes, (next) => {
      const nextIds = new Set(Object.keys(next.mcpServers) as Array<McpServerId>);
      const removed = [...knownIds].filter((id) => !nextIds.has(id));
      knownIds = nextIds;
      return Effect.forEach(
        removed,
        (id) => {
          for (const [state, entry] of pending) if (entry.id === id) pending.delete(state);
          return signOut({ id }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Removed MCP server's sign-in could not be deleted", {
                mcpServerId: id,
                detail: error.detail,
              }),
            ),
          );
        },
        { discard: true },
      );
    }),
  );

  return McpServerAuth.of({
    accessToken,
    isSignedIn: Effect.fn("McpServerAuth.isSignedIn")(function* (id, url) {
      return (yield* loginOf(id))?.serverUrl === url;
    }),
    // Read per server on every status list; a span each would be noise.
    revision: Effect.fnUntraced(function* (id) {
      return yield* Effect.sync(() => revisions.get(id) ?? 0);
    }),
    signIn,
    completeSignIn,
    signOut,
  });
});

export const layer = Layer.effect(McpServerAuth, make);

/**
 * Where the browser lands after signing in. Unauthenticated: the one-use `state` is what ties it
 * to a sign-in started here.
 */
export const callbackRouteLayer = HttpRouter.add(
  "GET",
  SIGN_IN_CALLBACK_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* McpServerAuth;
    return yield* auth
      .completeSignIn({ callbackUrl: new URL(request.url, "http://127.0.0.1").toString() })
      .pipe(
        Effect.map(() =>
          callbackPage(
            "Signed in · Вход выполнен",
            "Gustaf saved the sign-in for this MCP server. You can close this tab. · Gustaf сохранил вход для этого MCP-сервера, вкладку можно закрыть.",
          ),
        ),
        Effect.catchTags({
          McpServerAuthError: (error) =>
            Effect.succeed(
              callbackPage(
                "Sign-in not finished · Вход не завершён",
                `${error.detail.replace(/[<>&"]/g, "")} If you started it on another device, copy this page's address into Settings → MCP there. · Если вход начат на другом устройстве, вставьте адрес этой страницы в «Настройки → MCP» там.`,
              ),
            ),
        }),
      );
  }),
);
