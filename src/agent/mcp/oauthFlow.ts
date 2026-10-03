// The OAuth sign-in flow for HTTP MCP servers, with every side effect injected (`OAuthDeps`): discovery over `fetch`,
// the system browser, the Rust loopback listener and the Keychain. The app wires the real ones in runtime.ts; the
// tests wire fakes (tests/mcpOauth.test.mjs). Tokens only ever live in the Keychain entry `mcp:<id>:oauth` and in
// the `Authorization` header of requests to the MCP server; nothing here writes them to logs or error messages.
import type { FetchLike } from "./http";
import {
  OAuthError,
  SIGN_IN_NEEDED,
  authServerMetadataUrls,
  buildAuthorizationUrl,
  canonicalResource,
  isSecureEndpoint,
  parseAuthServerMetadata,
  parseProtectedResource,
  parseRegistration,
  parseStored,
  parseTokenResponse,
  parseWwwAuthenticate,
  pkcePair,
  protectedResourceMetadataUrls,
  randomToken,
  redirectUri,
  registrationBody,
  tokenDecision,
  tokenRequestBody,
  MAX_DOC_BYTES,
  type AuthServer,
  type Rng,
  type StoredOAuth,
} from "./oauth";
import { PROTOCOL_VERSION } from "./protocol";

export type OAuthDeps = {
  fetch: FetchLike;
  openUrl: (url: string) => Promise<void>;
  loopback: { start: (state: string, timeoutMs?: number) => Promise<{ id: string; port: number }>; wait: (id: string) => Promise<string>; cancel: (id: string) => Promise<void> };
  store: { get: (id: string) => Promise<string | null>; set: (id: string, value: string) => Promise<void>; delete: (id: string) => Promise<void> };
  now?: () => number;
  rng?: Rng;
};
export type Phase = "discovering" | "registering" | "browser" | "exchanging";
export type SignInOptions = { serverUrl: string; secretId: string; headers?: Record<string, string>; clientId?: string; scope?: string; signal?: AbortSignal; onPhase?: (p: Phase) => void; timeoutMs?: number };

const DOC_TIMEOUT_MS = 15_000;
const now = (d: OAuthDeps) => (d.now ?? Date.now)();

async function readBounded(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new OAuthError("an authorization response was too large");
      text += dec.decode(value, { stream: true });
    }
    return text + dec.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** One bounded request with a deadline; resolves with the status, headers and the JSON body (null when it is not JSON). */
async function send(d: OAuthDeps, url: string, init: RequestInit, signal?: AbortSignal): Promise<{ status: number; headers: Headers; json: unknown }> {
  if (!isSecureEndpoint(url)) throw new OAuthError("refusing to contact a non-https authorization endpoint", "insecure_endpoint");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DOC_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await d.fetch(url, { ...init, signal: ctl.signal });
    const text = await readBounded(res, MAX_DOC_BYTES);
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, headers: res.headers, json };
  } catch (e) {
    if (signal?.aborted) throw new OAuthError("sign-in cancelled", "cancelled");
    if (ctl.signal.aborted) throw new OAuthError("an authorization server did not answer in time", "timeout");
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const getJson = async (d: OAuthDeps, url: string, signal?: AbortSignal) => {
  const r = await send(d, url, { method: "GET", headers: { Accept: "application/json" } }, signal);
  return r.status >= 200 && r.status < 300 ? r.json : null;
};

/** Asks the server without a token and reads the challenge (`WWW-Authenticate`) of its 401. */
async function probe(d: OAuthDeps, o: SignInOptions) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "M Code", version: "0" } } });
  const headers = { ...(o.headers ?? {}), "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const r = await send(d, o.serverUrl, { method: "POST", headers, body }, o.signal);
  if (r.status !== 401) {
    if (r.status >= 200 && r.status < 300) throw new OAuthError("the server did not ask for authorization", "no_auth_required");
    return {};
  }
  return parseWwwAuthenticate(r.headers.get("www-authenticate"));
}

/** Finds the authorization server for an MCP server URL (protected resource metadata, then the origin as the issuer). */
async function discover(d: OAuthDeps, o: SignInOptions): Promise<{ server: AuthServer; scope?: string }> {
  const challenge = await probe(d, o);
  let issuer: string | undefined;
  let scopes: string | undefined;
  for (const url of protectedResourceMetadataUrls(o.serverUrl, challenge.resourceMetadata)) {
    const doc = await getJson(d, url, o.signal).catch((e) => {
      if (e instanceof OAuthError && e.code === "cancelled") throw e;
      return null;
    });
    if (!doc) continue;
    const pr = parseProtectedResource(doc, o.serverUrl);
    issuer = pr.authorizationServers[0];
    scopes = pr.scopes?.join(" ");
    break;
  }
  // Servers that predate protected resource metadata: their own origin acts as the authorization server.
  issuer ??= new URL(o.serverUrl).origin;
  for (const url of authServerMetadataUrls(issuer)) {
    const doc = await getJson(d, url, o.signal).catch((e) => {
      if (e instanceof OAuthError && e.code === "cancelled") throw e;
      return null;
    });
    if (doc) return { server: parseAuthServerMetadata(doc, issuer), scope: challenge.scope ?? scopes };
  }
  throw new OAuthError("could not find the authorization server metadata", "no_metadata");
}

async function tokenCall(d: OAuthDeps, endpoint: string, body: string, signal?: AbortSignal) {
  const r = await send(d, endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body }, signal);
  if (r.status < 200 || r.status >= 300) {
    // Only the error code and description are surfaced, never the raw body.
    const doc = r.json && typeof r.json === "object" && typeof (r.json as { error?: unknown }).error === "string" ? r.json : { error: `http_${r.status}` };
    parseTokenResponse(doc, 0);
  }
  return r.json;
}

/** Runs the whole sign-in and stores the tokens. Rejects with an `OAuthError` (or whatever the transport threw). */
export async function signIn(d: OAuthDeps, o: SignInOptions): Promise<void> {
  const phase = (p: Phase) => o.onPhase?.(p);
  phase("discovering");
  const { server, scope: advertised } = await discover(d, o);
  const resource = canonicalResource(o.serverUrl);
  const scope = o.scope || advertised;
  const state = randomToken(24, d.rng);
  const { verifier, challenge } = await pkcePair(d.rng);
  const listener = await d.loopback.start(state, o.timeoutMs);
  const redirect = redirectUri(listener.port);
  const onAbort = () => void d.loopback.cancel(listener.id).catch(() => {});
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let waiting: Promise<string> | undefined;
  try {
    let clientId = o.clientId;
    let clientSecret: string | undefined;
    if (!clientId) {
      if (!server.registrationEndpoint) throw new OAuthError("the authorization server does not support dynamic client registration; enter a client ID in the server settings", "no_registration");
      phase("registering");
      const r = await send(d, server.registrationEndpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(registrationBody(redirect)) }, o.signal);
      if (r.status < 200 || r.status >= 300) throw new OAuthError(`client registration was refused (HTTP ${r.status})`, "registration_failed");
      ({ clientId, clientSecret } = parseRegistration(r.json));
    }
    waiting = d.loopback.wait(listener.id);
    waiting.catch(() => {});
    phase("browser");
    await d.openUrl(buildAuthorizationUrl({ endpoint: server.authorizationEndpoint, clientId, redirectUri: redirect, state, challenge, resource, ...(scope ? { scope } : {}) }));
    const code = await waiting;
    phase("exchanging");
    const doc = await tokenCall(d, server.tokenEndpoint, tokenRequestBody({ grant: "authorization_code", code, redirectUri: redirect, clientId, ...(clientSecret ? { clientSecret } : {}), verifier, resource }), o.signal);
    const t = parseTokenResponse(doc, now(d));
    const stored: StoredOAuth = { ...t, tokenEndpoint: server.tokenEndpoint, clientId, ...(clientSecret ? { clientSecret } : {}), resource, issuer: server.issuer };
    await d.store.set(o.secretId, JSON.stringify(stored));
  } catch (e) {
    await d.loopback.cancel(listener.id).catch(() => {});
    if (waiting) await waiting.catch(() => {});
    if (o.signal?.aborted && !(e instanceof OAuthError && e.code === "cancelled")) throw new OAuthError("sign-in cancelled", "cancelled");
    throw e;
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
  }
}

// One refresh at a time per Keychain entry (a burst of 401s must not spend a rotating refresh token twice).
const refreshing = new Map<string, Promise<boolean>>();

/** Exchanges the refresh token. False when there is none or the server rejected it (the tokens are then deleted). */
export function refreshTokens(d: OAuthDeps, secretId: string, signal?: AbortSignal): Promise<boolean> {
  const running = refreshing.get(secretId);
  if (running) return running;
  const p = (async () => {
    const t = parseStored(await d.store.get(secretId));
    if (!t?.refreshToken) return false;
    try {
      const doc = await tokenCall(d, t.tokenEndpoint, tokenRequestBody({ grant: "refresh_token", refreshToken: t.refreshToken, clientId: t.clientId, ...(t.clientSecret ? { clientSecret: t.clientSecret } : {}), resource: t.resource, ...(t.scope ? { scope: t.scope } : {}) }), signal);
      const next = parseTokenResponse(doc, now(d), t);
      await d.store.set(secretId, JSON.stringify({ ...t, ...next, ...(next.expiresAt === undefined ? { expiresAt: undefined } : {}) } satisfies StoredOAuth));
      return true;
    } catch (e) {
      if (e instanceof OAuthError && (e.code === "invalid_grant" || e.code === "invalid_client" || e.code === "unauthorized_client")) {
        await d.store.delete(secretId).catch(() => {});
        return false;
      }
      throw e;
    }
  })().finally(() => refreshing.delete(secretId));
  refreshing.set(secretId, p);
  return p;
}

/** The `Authorization` header value for the next request, refreshing first when the token is (nearly) expired. */
export async function authorizationHeader(d: OAuthDeps, secretId: string): Promise<string> {
  let t = parseStored(await d.store.get(secretId));
  if (!t) throw new Error(SIGN_IN_NEEDED);
  const decision = tokenDecision(t, now(d));
  if (decision === "signin") throw new Error(SIGN_IN_NEEDED);
  if (decision === "refresh") {
    if (!(await refreshTokens(d, secretId))) throw new Error(SIGN_IN_NEEDED);
    t = parseStored(await d.store.get(secretId));
    if (!t) throw new Error(SIGN_IN_NEEDED);
  }
  return `Bearer ${t.accessToken}`;
}

export const isSignedIn = async (d: Pick<OAuthDeps, "store">, secretId: string) => !!parseStored(await d.store.get(secretId));
