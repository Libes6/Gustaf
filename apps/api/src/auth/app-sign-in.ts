import * as NodeCrypto from "node:crypto";

// Sign-in handoff for the desktop and mobile apps; the contract is docs/internals/app-sign-in.md.
export const APP_SIGN_IN_PATH = "/v1/auth/app";
export const REQUEST_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 2 * 60 * 1000;

const APP_REDIRECT_URIS = new Set(["gustaf://auth", "gustaf-dev://auth", "gustaf-preview://auth"]);
const LOOPBACK_REDIRECT_URI = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{3,4})\/callback$/;

export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (APP_REDIRECT_URIS.has(value)) return true;
  const port = LOOPBACK_REDIRECT_URI.exec(value)?.[1];
  return port !== undefined && Number(port) >= 1024 && Number(port) <= 65535;
}

// RFC 7636: S256 of a 32-byte verifier is 43 base64url characters; verifiers are 43-128 chars.
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[\x21-\x7e]{1,512}$/;
const CODE = /^[A-Za-z0-9_-]{43}$/;

export type StartRequest = { redirectUri: string; codeChallenge: string; state: string };

export function readStartRequest(
  query: Record<string, unknown>,
): { ok: true; value: StartRequest } | { ok: false; error: string } {
  const { redirect_uri, code_challenge, code_challenge_method, state } = query;
  if (!isAllowedRedirectUri(redirect_uri)) return { ok: false, error: "invalid_redirect_uri" };
  if (code_challenge_method !== "S256")
    return { ok: false, error: "invalid_code_challenge_method" };
  if (typeof code_challenge !== "string" || !CODE_CHALLENGE.test(code_challenge)) {
    return { ok: false, error: "invalid_code_challenge" };
  }
  if (typeof state !== "string" || !STATE.test(state)) return { ok: false, error: "invalid_state" };
  return { ok: true, value: { redirectUri: redirect_uri, codeChallenge: code_challenge, state } };
}

export type TokenRequest = { code: string; codeVerifier: string; redirectUri: string };

export function readTokenRequest(body: unknown): TokenRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { code, code_verifier, redirect_uri } = body as Record<string, unknown>;
  if (typeof code !== "string" || !CODE.test(code)) return undefined;
  if (typeof code_verifier !== "string" || !CODE_VERIFIER.test(code_verifier)) return undefined;
  if (typeof redirect_uri !== "string") return undefined;
  return { code, codeVerifier: code_verifier, redirectUri: redirect_uri };
}

export function verifyPkce(codeVerifier: string, codeChallenge: string) {
  const expected = Buffer.from(codeChallenge);
  const actual = Buffer.from(
    NodeCrypto.createHash("sha256").update(codeVerifier).digest("base64url"),
  );
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}

// 256 random bits: a SHA-256 lookup hash is enough, the plain value is never stored.
export function hashSecret(value: string) {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

export function createSecret() {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

export function appendQuery(uri: string, params: Record<string, string>) {
  return `${uri}${uri.includes("?") ? "&" : "?"}${new URLSearchParams(params).toString()}`;
}

type StoredCode = {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: Date;
  usedAt: Date | null;
};

export type Redemption = "ok" | "unknown" | "replay" | "expired" | "mismatch";

// Order matters: a used code is a replay even when expired or presented with a wrong verifier.
export function redeem(row: StoredCode | undefined, request: TokenRequest, now: Date): Redemption {
  if (!row) return "unknown";
  if (row.usedAt) return "replay";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.redirectUri !== request.redirectUri) return "mismatch";
  if (!verifyPkce(request.codeVerifier, row.codeChallenge)) return "mismatch";
  return "ok";
}

// Per-process, per-IP count of failed token exchanges in a fixed window. Several API instances
// each keep their own count, which only loosens the limit; codes are unguessable regardless.
export class FailureLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 10 * 60 * 1000,
    private readonly maxKeys = 10_000,
  ) {}

  blocked(key: string, now = Date.now()) {
    const window = this.windows.get(key);
    return window !== undefined && window.resetAt > now && window.count >= this.maxFailures;
  }

  fail(key: string, now = Date.now()) {
    const window = this.windows.get(key);
    if (window && window.resetAt > now) {
      window.count += 1;
      return;
    }
    if (this.windows.size >= this.maxKeys) {
      for (const [entry, { resetAt }] of this.windows)
        if (resetAt <= now) this.windows.delete(entry);
      if (this.windows.size >= this.maxKeys) this.windows.clear();
    }
    this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
  }
}
