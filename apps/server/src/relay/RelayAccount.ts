// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off extendsNativeError:off -- A one-shot loopback listener for the browser sign-in (RFC 8252), outside the Effect runtime like the relay engine.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

/**
 * Signs this computer in to the Gustaf cloud without the desktop app: PKCE through the system
 * browser to a loopback listener, then registers it as a computer. Only the device credential
 * is kept; the account session is signed out right away. Mirrors apps/shell/src-tauri/src/account.rs.
 */

export const DEFAULT_ACCOUNT_API_URL = "https://api.libes6.ru";
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export function resolveAccountApiUrl(value: string | undefined): string {
  try {
    const url = new URL(value?.trim() || DEFAULT_ACCOUNT_API_URL);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_ACCOUNT_API_URL;
    return url.origin;
  } catch {
    return DEFAULT_ACCOUNT_API_URL;
  }
}

export interface ComputerCredential {
  readonly relayUrl: string;
  readonly deviceId: string;
  readonly token: string;
}

export class RelayAccountError extends Error {
  override readonly name = "RelayAccountError";
}

export interface SignInComputerOptions {
  readonly apiUrl: string;
  readonly computerName: string;
  /** Shows the sign-in address; the browser must run on this machine to reach the loopback. */
  readonly openUrl: (url: string) => void;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const randomToken = () => NodeCrypto.randomBytes(32).toString("base64url");
const codeChallenge = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

const page = (title: string) =>
  `<!doctype html><meta charset=utf-8><title>Gustaf</title><body style="font:16px system-ui;margin:4rem;text-align:center"><h1>${title}</h1><p>You can close this tab and return to the terminal.</p>`;

type Callback =
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "denied"; readonly error: string }
  | { readonly kind: "state_mismatch" }
  | { readonly kind: "other" };

export function parseCallback(target: string, expectedState: string): Callback {
  let url: URL;
  try {
    url = new URL(target, "http://127.0.0.1");
  } catch {
    return { kind: "other" };
  }
  if (!target.startsWith("/") || url.pathname !== "/callback") return { kind: "other" };
  if (url.searchParams.get("state") !== expectedState) return { kind: "state_mismatch" };
  const error = url.searchParams.get("error");
  if (error !== null) return { kind: "denied", error };
  const code = url.searchParams.get("code");
  return code ? { kind: "code", code } : { kind: "denied", error: "invalid_response" };
}

export function deniedMessage(error: string): string {
  if (error === "access_denied") return "Sign-in was cancelled in the browser.";
  // The value comes from the address bar: show only a short, plain code.
  return /^[A-Za-z0-9_]{1,64}$/.test(error) ? `Sign-in failed (${error}).` : "Sign-in failed.";
}

function waitForCode(
  state: string,
  timeoutMs: number,
  onListening: (redirectUri: string) => void,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = NodeHttp.createServer((request, response) => {
      const callback: Callback =
        request.method === "GET" ? parseCallback(request.url ?? "", state) : { kind: "other" };
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
          answer(200, page("Signed in"));
          return finish(() => resolve({ code: callback.code, redirectUri }));
        case "denied":
          answer(200, page("Sign-in did not finish"));
          return finish(() => reject(new RelayAccountError(deniedMessage(callback.error))));
        case "state_mismatch":
          answer(400, page("Sign-in did not finish"));
          return finish(() =>
            reject(
              new RelayAccountError(
                "Sign-in was rejected: the browser answered for another attempt.",
              ),
            ),
          );
      }
    });
    const timer = setTimeout(
      () => finish(() => reject(new RelayAccountError("Sign-in timed out. Try again."))),
      timeoutMs,
    );
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      server.close();
      // Answered requests close themselves (`connection: close`); this drops idle preconnects.
      server.closeIdleConnections();
      settle();
    };
    server.on("error", (error) =>
      finish(() =>
        reject(new RelayAccountError(`Cannot listen for the sign-in answer: ${error.message}`)),
      ),
    );
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        return finish(() => reject(new RelayAccountError("Cannot listen for the sign-in answer.")));
      }
      redirectUri = `http://127.0.0.1:${address.port}/callback`;
      onListening(redirectUri);
    });
  });
}

async function cloudRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: { readonly token?: string; readonly body: unknown },
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      },
      body: JSON.stringify(init.body),
    });
  } catch {
    throw new RelayAccountError("Cannot reach the Gustaf cloud.");
  }
  if (response.status === 429)
    throw new RelayAccountError("Too many requests to the Gustaf cloud. Try again later.");
  if (!response.ok)
    throw new RelayAccountError(`The Gustaf cloud answered with HTTP ${response.status}.`);
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new RelayAccountError("The Gustaf cloud sent an unexpected answer.");
  }
}

export async function signInComputer(options: SignInComputerOptions): Promise<ComputerCredential> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const verifier = randomToken();
  const state = randomToken();
  const { code, redirectUri } = await waitForCode(
    state,
    options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    (redirect) => {
      const start = new URL("/v1/auth/app/start", options.apiUrl);
      start.searchParams.set("redirect_uri", redirect);
      start.searchParams.set("code_challenge", codeChallenge(verifier));
      start.searchParams.set("code_challenge_method", "S256");
      start.searchParams.set("state", state);
      options.openUrl(start.toString());
    },
  );
  const grant = await cloudRequest<{ token?: string }>(
    fetchImpl,
    new URL("/v1/auth/app/token", options.apiUrl).toString(),
    { body: { code, code_verifier: verifier, redirect_uri: redirectUri } },
  );
  if (typeof grant?.token !== "string" || grant.token === "")
    throw new RelayAccountError("The Gustaf cloud did not return a session.");
  try {
    const registered = await cloudRequest<{ device?: { id?: string }; token?: string }>(
      fetchImpl,
      new URL("/v1/devices", options.apiUrl).toString(),
      { token: grant.token, body: { name: options.computerName, kind: "computer" } },
    );
    const deviceId = registered?.device?.id;
    if (typeof deviceId !== "string" || typeof registered.token !== "string")
      throw new RelayAccountError("The Gustaf cloud did not register this computer.");
    return { relayUrl: options.apiUrl, deviceId, token: registered.token };
  } finally {
    // The device credential is all this computer keeps; best effort when offline.
    await cloudRequest(fetchImpl, new URL("/v1/auth/sign-out", options.apiUrl).toString(), {
      token: grant.token,
      body: {},
    }).catch(() => undefined);
  }
}
