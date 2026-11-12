/**
 * Noise_XX_25519_ChaChaPoly_BLAKE2s (https://noiseprotocol.org/noise.html, revision 34) for the
 * Gustaf relay. Only the XX pattern: pairing and reconnects use the same handshake, and each side
 * checks the other's static key afterwards. Primitives come from the audited @noble libraries;
 * this file is the spec's state machine, checked against the cacophony and snow test vectors.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { blake2s } from "@noble/hashes/blake2s";
import { hmac } from "@noble/hashes/hmac";

export const NOISE_PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
/** The largest Noise message, ciphertext and tag included. */
export const NOISE_MAX_MESSAGE_LENGTH = 65_535;
const TAG_LENGTH = 16;
const DH_LENGTH = 32;
const HASH_LENGTH = 32;
// The spec reserves 2^64 - 1; a JS number counts exactly to 2^53, far beyond any session.
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export interface NoiseKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export class NoiseError extends Error {
  override readonly name = "NoiseError";
}

export type RandomBytes = (length: number) => Uint8Array;

export function noiseKeyPairFromSecret(secretKey: Uint8Array): NoiseKeyPair {
  if (secretKey.length !== DH_LENGTH) throw new NoiseError("A Noise secret key is 32 bytes.");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

/** Mobile passes Expo's random source because Hermes has no `crypto.getRandomValues`. */
export function generateNoiseKeyPair(randomBytes: RandomBytes): NoiseKeyPair {
  return noiseKeyPairFromSecret(randomBytes(DH_LENGTH));
}

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n), true);
  return nonce;
}

/** One direction of an established session. Messages must arrive in order, exactly once. */
export class NoiseCipherState {
  #key: Uint8Array | null;
  #nonce = 0;

  constructor(key: Uint8Array | null = null) {
    this.#key = key;
  }

  get hasKey(): boolean {
    return this.#key !== null;
  }

  encrypt(plaintext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.#key === null) return plaintext;
    if (plaintext.length + TAG_LENGTH > NOISE_MAX_MESSAGE_LENGTH) {
      throw new NoiseError("Noise message is too long.");
    }
    const ciphertext = chacha20poly1305(this.#key, this.#nextNonce(), ad).encrypt(plaintext);
    return ciphertext;
  }

  decrypt(ciphertext: Uint8Array, ad: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (this.#key === null) return ciphertext;
    if (ciphertext.length < TAG_LENGTH || ciphertext.length > NOISE_MAX_MESSAGE_LENGTH) {
      throw new NoiseError("Noise message has an invalid length.");
    }
    const nonce = nonceBytes(this.#nonce);
    let plaintext: Uint8Array;
    try {
      plaintext = chacha20poly1305(this.#key, nonce, ad).decrypt(ciphertext);
    } catch {
      throw new NoiseError("Noise message failed authentication.");
    }
    // The nonce advances only after a message authenticates, as the spec requires.
    this.#advance();
    return plaintext;
  }

  #nextNonce(): Uint8Array {
    const nonce = nonceBytes(this.#nonce);
    this.#advance();
    return nonce;
  }

  #advance() {
    if (this.#nonce >= MAX_NONCE) throw new NoiseError("Noise nonce exhausted.");
    this.#nonce += 1;
  }
}

function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array) {
  const tempKey = hmac(blake2s, chainingKey, inputKeyMaterial);
  const output1 = hmac(blake2s, tempKey, Uint8Array.of(1));
  const output2 = hmac(blake2s, tempKey, concat(output1, Uint8Array.of(2)));
  return [output1, output2] as const;
}

class SymmetricState {
  chainingKey: Uint8Array;
  hash: Uint8Array;
  cipher = new NoiseCipherState();

  constructor() {
    const name = new TextEncoder().encode(NOISE_PROTOCOL_NAME);
    this.hash =
      name.length <= HASH_LENGTH
        ? concat(name, new Uint8Array(HASH_LENGTH - name.length))
        : blake2s(name);
    this.chainingKey = this.hash;
  }

  mixKey(inputKeyMaterial: Uint8Array) {
    const [chainingKey, key] = hkdf(this.chainingKey, inputKeyMaterial);
    this.chainingKey = chainingKey;
    this.cipher = new NoiseCipherState(key);
  }

  mixHash(data: Uint8Array) {
    this.hash = blake2s(concat(this.hash, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encrypt(plaintext, this.hash);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decrypt(ciphertext, this.hash);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): readonly [NoiseCipherState, NoiseCipherState] {
    const [key1, key2] = hkdf(this.chainingKey, new Uint8Array(0));
    return [new NoiseCipherState(key1), new NoiseCipherState(key2)];
  }
}

export interface NoiseSession {
  readonly send: NoiseCipherState;
  readonly receive: NoiseCipherState;
  readonly remoteStaticKey: Uint8Array;
  /** Equal on both ends of one handshake; the basis of a safety code. */
  readonly handshakeHash: Uint8Array;
}

export interface NoiseHandshakeOptions {
  readonly initiator: boolean;
  readonly staticKeyPair: NoiseKeyPair;
  readonly prologue: Uint8Array;
  readonly randomBytes: RandomBytes;
  /** Test vectors only: a fixed ephemeral key. */
  readonly ephemeralKeyPair?: NoiseKeyPair;
}

/**
 * XX: `-> e`, `<- e, ee, s, es`, `-> s, se`. Call `writeMessage` and `readMessage` in turn
 * (the initiator writes first); after the third message `session()` returns the transport.
 */
export class NoiseHandshake {
  readonly #initiator: boolean;
  readonly #static: NoiseKeyPair;
  readonly #randomBytes: RandomBytes;
  #ephemeral: NoiseKeyPair | null;
  #remoteEphemeral: Uint8Array | null = null;
  #remoteStatic: Uint8Array | null = null;
  #step = 0;
  #failed = false;
  readonly #state = new SymmetricState();

  constructor(options: NoiseHandshakeOptions) {
    this.#initiator = options.initiator;
    this.#static = options.staticKeyPair;
    this.#randomBytes = options.randomBytes;
    this.#ephemeral = options.ephemeralKeyPair ?? null;
    this.#state.mixHash(options.prologue);
  }

  get isComplete(): boolean {
    return this.#step === 3;
  }

  /** The peer's static key once it has been received (after message two for the initiator). */
  get remoteStaticKey(): Uint8Array | null {
    return this.#remoteStatic;
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    this.#expectTurn(true);
    return this.#guard(() => {
      const parts: Array<Uint8Array> = [];
      switch (this.#step) {
        case 0: {
          const ephemeral = this.#newEphemeral();
          parts.push(ephemeral.publicKey);
          this.#state.mixHash(ephemeral.publicKey);
          break;
        }
        case 1: {
          const ephemeral = this.#newEphemeral();
          parts.push(ephemeral.publicKey);
          this.#state.mixHash(ephemeral.publicKey);
          this.#state.mixKey(this.#dh(ephemeral, this.#remoteEphemeral!));
          parts.push(this.#state.encryptAndHash(this.#static.publicKey));
          this.#state.mixKey(this.#dh(this.#static, this.#remoteEphemeral!));
          break;
        }
        case 2: {
          parts.push(this.#state.encryptAndHash(this.#static.publicKey));
          this.#state.mixKey(this.#dh(this.#static, this.#remoteEphemeral!));
          break;
        }
      }
      parts.push(this.#state.encryptAndHash(payload));
      this.#step += 1;
      const message = concat(...parts);
      if (message.length > NOISE_MAX_MESSAGE_LENGTH)
        throw new NoiseError("Handshake payload is too long.");
      return message;
    });
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.#expectTurn(false);
    if (message.length > NOISE_MAX_MESSAGE_LENGTH)
      throw new NoiseError("Handshake message is too long.");
    return this.#guard(() => {
      let offset = 0;
      const take = (length: number) => {
        if (message.length - offset < length)
          throw new NoiseError("Handshake message is truncated.");
        const part = message.subarray(offset, offset + length);
        offset += length;
        return part;
      };
      const encryptedKeyLength = DH_LENGTH + TAG_LENGTH;
      switch (this.#step) {
        case 0: {
          this.#remoteEphemeral = take(DH_LENGTH).slice();
          this.#state.mixHash(this.#remoteEphemeral);
          break;
        }
        case 1: {
          this.#remoteEphemeral = take(DH_LENGTH).slice();
          this.#state.mixHash(this.#remoteEphemeral);
          this.#state.mixKey(this.#dh(this.#ephemeral!, this.#remoteEphemeral));
          this.#remoteStatic = this.#state.decryptAndHash(take(encryptedKeyLength));
          this.#state.mixKey(this.#dh(this.#ephemeral!, this.#remoteStatic));
          break;
        }
        case 2: {
          this.#remoteStatic = this.#state.decryptAndHash(take(encryptedKeyLength));
          this.#state.mixKey(this.#dh(this.#ephemeral!, this.#remoteStatic));
          break;
        }
      }
      const payload = this.#state.decryptAndHash(message.subarray(offset));
      this.#step += 1;
      return payload;
    });
  }

  session(): NoiseSession {
    if (!this.isComplete || this.#failed) throw new NoiseError("Handshake is not complete.");
    const [initiatorToResponder, responderToInitiator] = this.#state.split();
    return {
      send: this.#initiator ? initiatorToResponder : responderToInitiator,
      receive: this.#initiator ? responderToInitiator : initiatorToResponder,
      remoteStaticKey: this.#remoteStatic!,
      handshakeHash: this.#state.hash,
    };
  }

  #expectTurn(writing: boolean) {
    if (this.#failed) throw new NoiseError("Handshake already failed.");
    if (this.#step >= 3) throw new NoiseError("Handshake is already complete.");
    const initiatorTurn = this.#step % 2 === 0;
    if ((initiatorTurn === this.#initiator) !== writing) {
      throw new NoiseError(
        writing ? "Not this side's turn to write." : "Not this side's turn to read.",
      );
    }
  }

  // Any failure poisons the handshake: a partial state must never be reused.
  #guard<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      this.#failed = true;
      throw error instanceof NoiseError ? error : new NoiseError(String(error));
    }
  }

  #newEphemeral(): NoiseKeyPair {
    this.#ephemeral ??= generateNoiseKeyPair(this.#randomBytes);
    return this.#ephemeral;
  }

  #dh(keyPair: NoiseKeyPair, publicKey: Uint8Array): Uint8Array {
    // noble rejects low-order points, which would give an all-zero shared secret.
    return x25519.getSharedSecret(keyPair.secretKey, publicKey);
  }
}

/**
 * A code both people can compare on the two screens (like Signal's safety numbers): 12 digits from
 * both static keys, the same on either side and stable across sessions.
 */
export function relaySafetyCode(keyA: Uint8Array, keyB: Uint8Array): string {
  const [first, second] = compareBytes(keyA, keyB) <= 0 ? [keyA, keyB] : [keyB, keyA];
  const digest = blake2s(concat(new TextEncoder().encode("gustaf-relay-safety"), first, second));
  const groups: Array<string> = [];
  for (let index = 0; index < 4; index += 1) {
    const value = ((digest[index * 2]! << 8) | digest[index * 2 + 1]!) % 1000;
    groups.push(value.toString().padStart(3, "0"));
  }
  return groups.join(" ");
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
