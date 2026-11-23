import * as Crypto from "expo-crypto";

const BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 §5 base64url without padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64_URL[a >> 2];
    output += BASE64_URL[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) output += BASE64_URL[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) output += BASE64_URL[c & 0x3f];
  }
  return output;
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(new Uint8Array(digest));
}

export interface SignInSecrets {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly state: string;
}

/** A fresh RFC 7636 S256 verifier (43 chars from 32 random bytes) and an opaque state. */
export async function createSignInSecrets(): Promise<SignInSecrets> {
  const codeVerifier = base64UrlEncode(Crypto.getRandomBytes(32));
  return {
    codeVerifier,
    codeChallenge: await pkceChallenge(codeVerifier),
    state: base64UrlEncode(Crypto.getRandomBytes(16)),
  };
}
