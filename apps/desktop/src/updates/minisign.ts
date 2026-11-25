// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- The updater is Promise and stream code at the process boundary; its Node I/O is injected in tests.
/**
 * Minisign verification, compatible with `tauri signer sign`. Only prehashed ("ED") signatures are
 * accepted: Ed25519 over the BLAKE2b-512 digest, so a download is hashed as it arrives. The trusted
 * comment's global signature is checked too. https://jedisct1.github.io/minisign/#signature-format
 */
import * as NodeCrypto from "node:crypto";

const PREHASHED = "ED";
const LEGACY = "Ed";
const KEY_ID_BYTES = 8;
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";
// Prefix of an Ed25519 SubjectPublicKeyInfo; the 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type MinisignFailure =
  | "bad-public-key"
  | "bad-signature-format"
  | "legacy-signature"
  | "key-id-mismatch"
  | "bad-signature"
  | "bad-trusted-comment";

export class MinisignError extends Error {
  readonly reason: MinisignFailure;

  constructor(reason: MinisignFailure, message: string) {
    super(message);
    this.name = "MinisignError";
    this.reason = reason;
  }
}

export interface MinisignPublicKey {
  readonly keyId: Buffer;
  readonly key: Buffer;
}

export interface MinisignSignature {
  readonly keyId: Buffer;
  readonly signature: Buffer;
  readonly trustedComment: string;
  readonly globalSignature: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeBase64(text: string): Buffer | undefined {
  const trimmed = text.trim();
  return BASE64.test(trimmed) ? Buffer.from(trimmed, "base64") : undefined;
}

function looksLikeMinisignFile(text: string): boolean {
  return text.trimStart().startsWith("untrusted comment:");
}

/** Accepts a `.pub` file, its base64 (what Tauri configs and CI variables hold), or the bare key line. */
export function parsePublicKey(input: string): MinisignPublicKey {
  let text = input.trim();
  if (!looksLikeMinisignFile(text)) {
    const decoded = decodeBase64(text);
    if (decoded !== undefined && looksLikeMinisignFile(decoded.toString("utf8"))) {
      text = decoded.toString("utf8");
    }
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const keyLine = looksLikeMinisignFile(text) ? lines[1] : lines[0];
  const raw = keyLine === undefined ? undefined : decodeBase64(keyLine);
  if (
    raw === undefined ||
    raw.length !== 2 + KEY_ID_BYTES + ED25519_PUBLIC_KEY_BYTES ||
    raw.subarray(0, 2).toString("latin1") !== LEGACY
  ) {
    throw new MinisignError("bad-public-key", "The update public key is not a minisign key.");
  }
  return {
    keyId: raw.subarray(2, 2 + KEY_ID_BYTES),
    key: raw.subarray(2 + KEY_ID_BYTES),
  };
}

/** Accepts a `.minisig` file or its base64 (the manifest's `signature` field). */
export function parseSignature(input: string): MinisignSignature {
  let text = input.trim();
  if (!looksLikeMinisignFile(text)) {
    const decoded = decodeBase64(text);
    if (decoded === undefined) {
      throw new MinisignError("bad-signature-format", "The update signature is not minisign.");
    }
    text = decoded.toString("utf8");
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const [, signatureLine, commentLine, globalLine] = lines;
  if (
    lines.length !== 4 ||
    signatureLine === undefined ||
    commentLine === undefined ||
    globalLine === undefined ||
    !looksLikeMinisignFile(text) ||
    !commentLine.startsWith(TRUSTED_COMMENT_PREFIX)
  ) {
    throw new MinisignError("bad-signature-format", "The update signature is not minisign.");
  }
  const raw = decodeBase64(signatureLine);
  const global = decodeBase64(globalLine);
  if (
    raw === undefined ||
    global === undefined ||
    raw.length !== 2 + KEY_ID_BYTES + ED25519_SIGNATURE_BYTES ||
    global.length !== ED25519_SIGNATURE_BYTES
  ) {
    throw new MinisignError("bad-signature-format", "The update signature is malformed.");
  }
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (algorithm === LEGACY) {
    throw new MinisignError("legacy-signature", "Legacy (unhashed) signatures are not accepted.");
  }
  if (algorithm !== PREHASHED) {
    throw new MinisignError("bad-signature-format", "Unknown minisign signature algorithm.");
  }
  return {
    keyId: raw.subarray(2, 2 + KEY_ID_BYTES),
    signature: raw.subarray(2 + KEY_ID_BYTES),
    trustedComment: commentLine.slice(TRUSTED_COMMENT_PREFIX.length),
    globalSignature: global,
  };
}

function ed25519Verify(key: Buffer, message: Uint8Array, signature: Buffer): boolean {
  try {
    const publicKey = NodeCrypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, key]),
      format: "der",
      type: "spki",
    });
    return NodeCrypto.verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/** Checks both signatures against the BLAKE2b-512 digest of the file. Throws on any mismatch. */
export function verifyDigest(
  publicKey: MinisignPublicKey,
  signature: MinisignSignature,
  digest: Uint8Array,
): void {
  if (!publicKey.keyId.equals(signature.keyId)) {
    throw new MinisignError("key-id-mismatch", "The update is signed with a different key.");
  }
  if (!ed25519Verify(publicKey.key, digest, signature.signature)) {
    throw new MinisignError("bad-signature", "The update's signature does not match its file.");
  }
  const trusted = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment)]);
  if (!ed25519Verify(publicKey.key, trusted, signature.globalSignature)) {
    throw new MinisignError("bad-trusted-comment", "The update's signed comment was altered.");
  }
}
