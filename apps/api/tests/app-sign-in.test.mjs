import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import {
  appendQuery,
  FailureLimiter,
  isAllowedRedirectUri,
  readStartRequest,
  readTokenRequest,
  redeem,
  verifyPkce,
} from "../dist/auth/app-sign-in.js";

const verifier = NodeCrypto.randomBytes(32).toString("base64url");
const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

NodeTest.test("redirect_uri allowlist is exact", () => {
  for (const uri of [
    "gustaf://auth",
    "gustaf-dev://auth",
    "gustaf-preview://auth",
    "http://127.0.0.1:1024/callback",
    "http://localhost:65535/callback",
    "http://127.0.0.1:49152/callback",
  ]) {
    NodeAssert.equal(isAllowedRedirectUri(uri), true, uri);
  }
  for (const uri of [
    undefined,
    ["gustaf://auth"],
    "",
    "gustaf://auth/",
    "gustaf://auth?x=1",
    "gustaf://auth#x",
    "gustaf://other",
    "GUSTAF://auth",
    "gustaf-evil://auth",
    "https://127.0.0.1:4000/callback",
    "http://127.0.0.1:1023/callback",
    "http://127.0.0.1:65536/callback",
    "http://127.0.0.1:080/callback",
    "http://127.0.0.1/callback",
    "http://127.0.0.1:4000/callback/",
    "http://127.0.0.1:4000/callback?x=1",
    "http://127.0.0.1:4000/callback#x",
    "http://user:pass@127.0.0.1:4000/callback",
    "http://127.0.0.1.evil.test:4000/callback",
    "http://[::1]:4000/callback",
    "http://localhost.evil.test:4000/callback",
    "http://evil.test/callback?http://127.0.0.1:4000/callback",
  ]) {
    NodeAssert.equal(isAllowedRedirectUri(uri), false, String(uri));
  }
});

NodeTest.test("start and token requests are parsed strictly", () => {
  const start = {
    redirect_uri: "gustaf://auth",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "opaque-state",
  };
  NodeAssert.deepEqual(readStartRequest(start), {
    ok: true,
    value: { redirectUri: "gustaf://auth", codeChallenge: challenge, state: "opaque-state" },
  });
  for (const [patch, error] of [
    [{ redirect_uri: "https://evil.test" }, "invalid_redirect_uri"],
    [{ code_challenge_method: "plain" }, "invalid_code_challenge_method"],
    [{ code_challenge_method: undefined }, "invalid_code_challenge_method"],
    [{ code_challenge: "short" }, "invalid_code_challenge"],
    [{ code_challenge: [challenge, challenge] }, "invalid_code_challenge"],
    [{ state: "" }, "invalid_state"],
    [{ state: "has space" }, "invalid_state"],
    [{ state: "x".repeat(513) }, "invalid_state"],
  ]) {
    NodeAssert.deepEqual(readStartRequest({ ...start, ...patch }), { ok: false, error });
  }
  const code = NodeCrypto.randomBytes(32).toString("base64url");
  const token = { code, code_verifier: verifier, redirect_uri: "gustaf://auth" };
  NodeAssert.deepEqual(readTokenRequest(token), {
    code,
    codeVerifier: verifier,
    redirectUri: "gustaf://auth",
  });
  for (const body of [
    undefined,
    null,
    "code",
    { ...token, code: "short" },
    { ...token, code_verifier: "x".repeat(42) },
    { ...token, code_verifier: "x".repeat(129) },
    { ...token, redirect_uri: undefined },
  ]) {
    NodeAssert.equal(readTokenRequest(body), undefined);
  }
});

NodeTest.test("PKCE S256 accepts only the matching verifier", () => {
  NodeAssert.equal(verifyPkce(verifier, challenge), true);
  NodeAssert.equal(verifyPkce(`${verifier}x`, challenge), false);
  NodeAssert.equal(verifyPkce(challenge, challenge), false);
  NodeAssert.equal(verifyPkce(verifier, "short"), false);
});

NodeTest.test("a code redeems once, before expiry, for its redirect_uri and verifier", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const row = {
    codeChallenge: challenge,
    redirectUri: "gustaf://auth",
    expiresAt: new Date(now.getTime() + 1000),
    usedAt: null,
  };
  const request = { code: "c", codeVerifier: verifier, redirectUri: "gustaf://auth" };
  NodeAssert.equal(redeem(row, request, now), "ok");
  NodeAssert.equal(redeem(undefined, request, now), "unknown");
  NodeAssert.equal(redeem({ ...row, usedAt: now }, request, now), "replay");
  NodeAssert.equal(
    redeem({ ...row, usedAt: now, expiresAt: now }, { ...request, codeVerifier: "x" }, now),
    "replay",
  );
  NodeAssert.equal(redeem(row, request, row.expiresAt), "expired");
  NodeAssert.equal(redeem(row, { ...request, redirectUri: "gustaf-dev://auth" }, now), "mismatch");
  NodeAssert.equal(redeem(row, { ...request, codeVerifier: `${verifier}x` }, now), "mismatch");
});

NodeTest.test("redirect query is appended and failures are limited per key and window", () => {
  NodeAssert.equal(
    appendQuery("gustaf://auth", { code: "a b", state: "s" }),
    "gustaf://auth?code=a+b&state=s",
  );
  NodeAssert.equal(appendQuery("gustaf://auth?x=1", { state: "s" }), "gustaf://auth?x=1&state=s");

  const limiter = new FailureLimiter(2, 1000, 2);
  limiter.fail("a", 0);
  NodeAssert.equal(limiter.blocked("a", 0), false);
  limiter.fail("a", 1);
  NodeAssert.equal(limiter.blocked("a", 1), true);
  NodeAssert.equal(limiter.blocked("b", 1), false);
  NodeAssert.equal(limiter.blocked("a", 1000), false);
  limiter.fail("b", 2);
  limiter.fail("c", 3);
  limiter.fail("c", 3);
  NodeAssert.equal(limiter.blocked("c", 3), true);
});
