import * as NodeCrypto from "node:crypto";

const PREFIX = "gdt_";

// 256 random bits: a fast SHA-256 lookup hash is enough, no password hashing needed.
export function hashDeviceToken(token: string) {
  return NodeCrypto.createHash("sha256").update(token).digest("hex");
}

export function createDeviceToken() {
  const token = PREFIX + NodeCrypto.randomBytes(32).toString("base64url");
  return { token, hash: hashDeviceToken(token) };
}

export function readDeviceToken(authorization: string | undefined) {
  const match = /^Bearer\s+(gdt_[A-Za-z0-9_-]{43})$/i.exec(authorization?.trim() ?? "");
  return match?.[1];
}
