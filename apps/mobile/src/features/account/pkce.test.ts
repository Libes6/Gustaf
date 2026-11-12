/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  digest: (algorithm: string, data: Uint8Array) =>
    Promise.resolve(new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer),
}));

import { base64UrlEncode, createSignInSecrets, pkceChallenge } from "./pkce";

describe("PKCE", () => {
  it.each([0, 1, 2, 3, 31, 32, 33])("base64url-encodes %d bytes like Node", (length) => {
    const bytes = new Uint8Array(NodeCrypto.randomBytes(length));
    expect(base64UrlEncode(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
  });

  it("derives the RFC 7636 appendix B S256 challenge", async () => {
    expect(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("creates a fresh 43-character verifier, its challenge and a state", async () => {
    const first = await createSignInSecrets();
    const second = await createSignInSecrets();

    expect(first.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.codeChallenge).toBe(await pkceChallenge(first.codeVerifier));
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
    expect(second.state).not.toBe(first.state);
  });
});
