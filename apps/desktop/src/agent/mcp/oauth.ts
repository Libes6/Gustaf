// MCP authorization (spec 2025-06-18, built on OAuth 2.1, RFC 9728 protected resource metadata, RFC 8414 authorization
// server metadata, RFC 7591 dynamic client registration, RFC 7636 PKCE, RFC 8707 resource indicators, RFC 8252
// loopback redirects): the pure parts. Documents are parsed and validated here, requests and URLs are built here, the
// token policy lives here. The network, the browser and the Keychain are reached through `oauthFlow.ts`.
// Pure: unit-tested in tests/mcpOauth.test.mjs. Nothing in this file logs.

export const SIGN_IN_NEEDED = "MCP server requires sign-in: open Settings, MCP servers and use Sign in";
export const REDIRECT_PATH = "/callback";
/** A token this close to its expiry is refreshed before use. */
export const REFRESH_SKEW_MS = 60_000;
export const MAX_DOC_BYTES = 1024 * 1024;

export class OAuthError extends Error {
  code: string;
  constructor(message: string, code = "oauth_error") {
    super(message);
    this.code = code;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isLoopbackHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");

/** https anywhere; plain http only to this machine (spec: HTTPS is required except for loopback). */
export function isSecureEndpoint(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  try {
    const u = new URL(url);
    if (u.username || u.password || u.hash) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && isLoopbackHost(u.hostname));
  } catch {
    return false;
  }
}

const mustBeSecure = (url: unknown, what: string): string => {
  if (!isSecureEndpoint(url)) throw new OAuthError(`${what} must be an https URL (http only for localhost)`, "insecure_endpoint");
  return url;
};

// ---- challenge and discovery ---------------------------------------------------------------------------------------

/** Parameters of the `Bearer` challenge in a `WWW-Authenticate` header (RFC 6750 / RFC 9728). */
export function parseWwwAuthenticate(header: string | null | undefined): { resourceMetadata?: string; scope?: string; error?: string } {
  if (!header) return {};
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,"]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header))) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = (m[2] ?? m[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return {
    ...(out.resource_metadata ? { resourceMetadata: out.resource_metadata } : {}),
    ...(out.scope ? { scope: clip(out.scope, 512) } : {}),
    ...(out.error ? { error: clip(out.error, 64) } : {}),
  };
}

/** The resource identifier sent as `resource` (RFC 8707): the server URL without query and fragment, no trailing slash. */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

/** Whether a protected resource's declared identifier covers the server URL (same origin, path prefix). */
export function resourceMatches(serverUrl: string, resource: string): boolean {
  try {
    const s = new URL(serverUrl);
    const r = new URL(resource);
    if (s.origin !== r.origin) return false;
    const rp = r.pathname.replace(/\/+$/, "");
    return rp === "" || s.pathname === rp || s.pathname.startsWith(rp + "/");
  } catch {
    return false;
  }
}

/** Where to look for the protected resource metadata: the challenge's hint first, then the well-known locations. */
export function protectedResourceMetadataUrls(serverUrl: string, hint?: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const urls = [...(hint && isSecureEndpoint(hint) ? [hint] : []), ...(path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []), `${u.origin}/.well-known/oauth-protected-resource`];
  return [...new Set(urls)];
}

export type ProtectedResource = { resource: string; authorizationServers: string[]; scopes?: string[] };

export function parseProtectedResource(doc: unknown, serverUrl: string): ProtectedResource {
  if (!doc || typeof doc !== "object") throw new OAuthError("invalid protected resource metadata");
  const d = doc as Record<string, unknown>;
  const resource = typeof d.resource === "string" ? d.resource : "";
  if (!resource || !resourceMatches(serverUrl, resource)) throw new OAuthError("the protected resource metadata does not describe this server", "resource_mismatch");
  const servers = (Array.isArray(d.authorization_servers) ? d.authorization_servers : []).filter(isSecureEndpoint).slice(0, 10);
  if (!servers.length) throw new OAuthError("the protected resource names no usable (https) authorization server", "no_authorization_server");
  const scopes = Array.isArray(d.scopes_supported) ? d.scopes_supported.filter((x): x is string => typeof x === "string" && !!x && x.length <= 128).slice(0, 50) : [];
  return { resource, authorizationServers: servers, ...(scopes.length ? { scopes } : {}) };
}

/** RFC 8414 / OpenID Connect discovery locations for an issuer, in the order the MCP spec asks clients to try. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, "");
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`];
}

export type AuthServer = { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint?: string };

const normIssuer = (s: string) => s.replace(/\/+$/, "");

/** Validates authorization server metadata: issuer match, secure endpoints, PKCE S256 advertised (the spec requires refusing otherwise). */
export function parseAuthServerMetadata(doc: unknown, issuer: string): AuthServer {
  if (!doc || typeof doc !== "object") throw new OAuthError("invalid authorization server metadata");
  const d = doc as Record<string, unknown>;
  if (typeof d.issuer !== "string" || normIssuer(d.issuer) !== normIssuer(issuer)) throw new OAuthError("the authorization server metadata names a different issuer", "issuer_mismatch");
  const methods = Array.isArray(d.code_challenge_methods_supported) ? d.code_challenge_methods_supported : [];
  if (!methods.includes("S256")) throw new OAuthError("the authorization server does not advertise PKCE with S256", "no_pkce");
  if (Array.isArray(d.grant_types_supported) && !d.grant_types_supported.includes("authorization_code")) throw new OAuthError("the authorization server does not support the authorization code grant", "no_code_grant");
  return {
    issuer: d.issuer,
    authorizationEndpoint: mustBeSecure(d.authorization_endpoint, "the authorization endpoint"),
    tokenEndpoint: mustBeSecure(d.token_endpoint, "the token endpoint"),
    ...(d.registration_endpoint !== undefined ? { registrationEndpoint: mustBeSecure(d.registration_endpoint, "the registration endpoint") } : {}),
  };
}

// ---- PKCE, state ---------------------------------------------------------------------------------------------------

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Rng = (bytes: Uint8Array) => Uint8Array;
const systemRng: Rng = (b) => {
  crypto.getRandomValues(b as Uint8Array<ArrayBuffer>);
  return b;
};

/** URL-safe random string from `bytes` random bytes (32 gives 43 characters, the minimum a PKCE verifier may have). */
export const randomToken = (bytes = 32, rng: Rng = systemRng) => base64url(rng(new Uint8Array(bytes)));

/** `code_challenge` for a verifier: BASE64URL(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function pkcePair(rng: Rng = systemRng): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken(32, rng);
  return { verifier, challenge: await codeChallenge(verifier) };
}

// ---- requests ------------------------------------------------------------------------------------------------------

export const redirectUri = (port: number) => `http://127.0.0.1:${port}${REDIRECT_PATH}`;

export function buildAuthorizationUrl(o: { endpoint: string; clientId: string; redirectUri: string; state: string; challenge: string; resource: string; scope?: string }): string {
  const u = new URL(o.endpoint);
  const p = u.searchParams;
  p.set("response_type", "code");
  p.set("client_id", o.clientId);
  p.set("redirect_uri", o.redirectUri);
  p.set("state", o.state);
  p.set("code_challenge", o.challenge);
  p.set("code_challenge_method", "S256");
  p.set("resource", o.resource);
  if (o.scope) p.set("scope", o.scope);
  return u.toString();
}

/** RFC 7591 request body: a public native client using the authorization code flow. */
export const registrationBody = (redirect: string, clientName = "M Code") => ({
  client_name: clientName,
  redirect_uris: [redirect],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
});

export function parseRegistration(doc: unknown): { clientId: string; clientSecret?: string } {
  const d = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  if (typeof d.client_id !== "string" || !d.client_id || d.client_id.length > 1024) throw new OAuthError("the client registration returned no client_id", "registration_failed");
  return { clientId: d.client_id, ...(typeof d.client_secret === "string" && d.client_secret ? { clientSecret: d.client_secret.slice(0, 4096) } : {}) };
}

type CodeGrant = { grant: "authorization_code"; code: string; redirectUri: string; clientId: string; clientSecret?: string; verifier: string; resource: string };
type RefreshGrant = { grant: "refresh_token"; refreshToken: string; clientId: string; clientSecret?: string; resource: string; scope?: string };

/** application/x-www-form-urlencoded body of a token request. */
export function tokenRequestBody(g: CodeGrant | RefreshGrant): string {
  const p = new URLSearchParams();
  p.set("grant_type", g.grant);
  if (g.grant === "authorization_code") {
    p.set("code", g.code);
    p.set("redirect_uri", g.redirectUri);
    p.set("code_verifier", g.verifier);
  } else {
    p.set("refresh_token", g.refreshToken);
    if (g.scope) p.set("scope", g.scope);
  }
  p.set("client_id", g.clientId);
  if (g.clientSecret) p.set("client_secret", g.clientSecret);
  p.set("resource", g.resource);
  return p.toString();
}

// ---- tokens --------------------------------------------------------------------------------------------------------

/** What is kept in the Keychain under `mcp:<id>:oauth` (JSON). */
export type StoredOAuth = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms; absent when the server gave no `expires_in`. */
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  resource: string;
  issuer: string;
  scope?: string;
};

/** Reads a token endpoint answer. `prev` supplies the refresh token a refresh response may omit. */
export function parseTokenResponse(doc: unknown, now: number, prev?: Pick<StoredOAuth, "refreshToken" | "scope">): { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string } {
  const d = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  if (typeof d.error === "string") {
    const code = clip(d.error.replace(/[^A-Za-z0-9_.-]/g, ""), 64) || "oauth_error";
    const desc = typeof d.error_description === "string" ? `: ${clip(d.error_description.replace(/[^\x20-\x7e]/g, " "), 200)}` : "";
    throw new OAuthError(`the token endpoint answered ${code}${desc}`, code);
  }
  if (typeof d.access_token !== "string" || !d.access_token) throw new OAuthError("the token endpoint returned no access token", "no_access_token");
  if (typeof d.token_type !== "string" || d.token_type.toLowerCase() !== "bearer") throw new OAuthError("the token endpoint returned an unsupported token type", "bad_token_type");
  const refreshToken = typeof d.refresh_token === "string" && d.refresh_token ? d.refresh_token : prev?.refreshToken;
  const expiresIn = typeof d.expires_in === "number" ? d.expires_in : typeof d.expires_in === "string" ? Number(d.expires_in) : NaN;
  const scope = typeof d.scope === "string" && d.scope ? clip(d.scope, 512) : prev?.scope;
  return {
    accessToken: d.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + Math.floor(expiresIn * 1000) } : {}),
    ...(scope ? { scope } : {}),
  };
}

/** Validates what comes back from the Keychain (a corrupted or foreign entry is treated as "not signed in"). */
export function parseStored(text: string | null | undefined): StoredOAuth | null {
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    if (typeof d.accessToken !== "string" || !d.accessToken || typeof d.clientId !== "string" || typeof d.tokenEndpoint !== "string" || !isSecureEndpoint(d.tokenEndpoint) || typeof d.resource !== "string" || typeof d.issuer !== "string") return null;
    return {
      accessToken: d.accessToken,
      ...(typeof d.refreshToken === "string" && d.refreshToken ? { refreshToken: d.refreshToken } : {}),
      ...(typeof d.expiresAt === "number" && Number.isFinite(d.expiresAt) ? { expiresAt: d.expiresAt } : {}),
      tokenEndpoint: d.tokenEndpoint,
      clientId: d.clientId,
      ...(typeof d.clientSecret === "string" && d.clientSecret ? { clientSecret: d.clientSecret } : {}),
      resource: d.resource,
      issuer: d.issuer,
      ...(typeof d.scope === "string" && d.scope ? { scope: d.scope } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * What to do with stored tokens before a request: use the access token, refresh it first (it is expired or about to be
 * and there is a refresh token), or send the user to sign in again (expired with no refresh token). An unknown expiry
 * means "use": a 401 then triggers one refresh.
 */
export function tokenDecision(t: Pick<StoredOAuth, "expiresAt" | "refreshToken">, now: number): "use" | "refresh" | "signin" {
  if (t.expiresAt === undefined || now < t.expiresAt - REFRESH_SKEW_MS) return "use";
  if (t.refreshToken) return "refresh";
  return now < t.expiresAt ? "use" : "signin";
}
