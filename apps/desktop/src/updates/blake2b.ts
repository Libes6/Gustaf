// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- The updater is Promise and stream code at the process boundary; its Node I/O is injected in tests.
/**
 * Streaming BLAKE2b-512 (RFC 7693). Electron links BoringSSL, whose `crypto` has no `blake2b512`
 * hash, while minisign's prehashed signatures need exactly that digest of the whole update file.
 * Node's native hash is used wherever it exists; this implementation is the fallback.
 */
import * as NodeCrypto from "node:crypto";

const BLOCK_BYTES = 128;
const MAX_DIGEST_BYTES = 64;

// The low and high 32-bit halves of the eight 64-bit initialization words.
const IV_LO = [
  0xf3bcc908, 0x84caa73b, 0xfe94f82b, 0x5f1d36f1, 0xade682d1, 0x2b3e6c1f, 0xfb41bd6b, 0x137e2179,
];
const IV_HI = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
] as const;

// Little-endian hosts only: blocks are viewed as 32-bit words without a byte swap.
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export class Blake2b512 {
  // Word i of the chained state is h[2 * i] (low half) and h[2 * i + 1] (high half).
  private readonly h = new Uint32Array(16);
  private readonly v = new Uint32Array(32);
  private readonly block = new Uint8Array(BLOCK_BYTES);
  private readonly words = new Uint32Array(this.block.buffer);
  private used = 0;
  private counter = 0;
  private finished = false;

  constructor() {
    if (!IS_LITTLE_ENDIAN) throw new Error("BLAKE2b needs a little-endian host.");
    for (let i = 0; i < 8; i++) {
      this.h[2 * i] = IV_LO[i]!;
      this.h[2 * i + 1] = IV_HI[i]!;
    }
    // Parameter block: digest length 64, no key, fanout 1, depth 1.
    this.h[0] = (this.h[0]! ^ (MAX_DIGEST_BYTES | (1 << 16) | (1 << 24))) >>> 0;
  }

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("BLAKE2b digest already taken.");
    let offset = 0;
    while (offset < data.length) {
      // The last block must be compressed with the final flag, so a full block waits for more data.
      if (this.used === BLOCK_BYTES) {
        this.counter += BLOCK_BYTES;
        this.compress(false);
        this.used = 0;
      }
      const take = Math.min(BLOCK_BYTES - this.used, data.length - offset);
      this.block.set(data.subarray(offset, offset + take), this.used);
      this.used += take;
      offset += take;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("BLAKE2b digest already taken.");
    this.finished = true;
    this.counter += this.used;
    this.block.fill(0, this.used);
    this.compress(true);
    const out = new Uint8Array(MAX_DIGEST_BYTES);
    new Uint32Array(out.buffer).set(this.h);
    return out;
  }

  private compress(last: boolean): void {
    const { h, v, words: m } = this;
    for (let i = 0; i < 16; i++) v[i] = h[i]!;
    for (let i = 0; i < 8; i++) {
      v[16 + 2 * i] = IV_LO[i]!;
      v[17 + 2 * i] = IV_HI[i]!;
    }
    // The 128-bit counter's low word is the byte count; it stays below 2^53.
    v[24] = (v[24]! ^ this.counter) >>> 0;
    v[25] = (v[25]! ^ Math.floor(this.counter / 4294967296)) >>> 0;
    if (last) {
      v[28] = ~v[28]! >>> 0;
      v[29] = ~v[29]! >>> 0;
    }
    for (let round = 0; round < 12; round++) {
      const s = SIGMA[round % 10]!;
      mix(v, 0, 4, 8, 12, m, s[0]!, s[1]!);
      mix(v, 1, 5, 9, 13, m, s[2]!, s[3]!);
      mix(v, 2, 6, 10, 14, m, s[4]!, s[5]!);
      mix(v, 3, 7, 11, 15, m, s[6]!, s[7]!);
      mix(v, 0, 5, 10, 15, m, s[8]!, s[9]!);
      mix(v, 1, 6, 11, 12, m, s[10]!, s[11]!);
      mix(v, 2, 7, 8, 13, m, s[12]!, s[13]!);
      mix(v, 3, 4, 9, 14, m, s[14]!, s[15]!);
    }
    for (let i = 0; i < 16; i++) h[i] = (h[i]! ^ v[i]! ^ v[i + 16]!) >>> 0;
  }
}

// One G step on 64-bit words kept as (low, high) pairs of 32-bit halves.
function mix(
  v: Uint32Array,
  a: number,
  b: number,
  c: number,
  d: number,
  m: Uint32Array,
  xi: number,
  yi: number,
): void {
  let al = v[2 * a]!;
  let ah = v[2 * a + 1]!;
  let bl = v[2 * b]!;
  let bh = v[2 * b + 1]!;
  let cl = v[2 * c]!;
  let ch = v[2 * c + 1]!;
  let dl = v[2 * d]!;
  let dh = v[2 * d + 1]!;
  let sum: number;
  let t: number;

  // a = a + b + x
  sum = al + bl + m[2 * xi]!;
  ah = (ah + bh + m[2 * xi + 1]! + Math.floor(sum / 4294967296)) >>> 0;
  al = sum >>> 0;
  // d = (d ^ a) >>> 32
  t = (dl ^ al) >>> 0;
  dl = (dh ^ ah) >>> 0;
  dh = t;
  // c = c + d
  sum = cl + dl;
  ch = (ch + dh + Math.floor(sum / 4294967296)) >>> 0;
  cl = sum >>> 0;
  // b = (b ^ c) >>> 24
  bl = (bl ^ cl) >>> 0;
  bh = (bh ^ ch) >>> 0;
  t = ((bl >>> 24) | (bh << 8)) >>> 0;
  bh = ((bh >>> 24) | (bl << 8)) >>> 0;
  bl = t;
  // a = a + b + y
  sum = al + bl + m[2 * yi]!;
  ah = (ah + bh + m[2 * yi + 1]! + Math.floor(sum / 4294967296)) >>> 0;
  al = sum >>> 0;
  // d = (d ^ a) >>> 16
  dl = (dl ^ al) >>> 0;
  dh = (dh ^ ah) >>> 0;
  t = ((dl >>> 16) | (dh << 16)) >>> 0;
  dh = ((dh >>> 16) | (dl << 16)) >>> 0;
  dl = t;
  // c = c + d
  sum = cl + dl;
  ch = (ch + dh + Math.floor(sum / 4294967296)) >>> 0;
  cl = sum >>> 0;
  // b = (b ^ c) >>> 63
  bl = (bl ^ cl) >>> 0;
  bh = (bh ^ ch) >>> 0;
  t = ((bl << 1) | (bh >>> 31)) >>> 0;
  bh = ((bh << 1) | (bl >>> 31)) >>> 0;
  bl = t;

  v[2 * a] = al;
  v[2 * a + 1] = ah;
  v[2 * b] = bl;
  v[2 * b + 1] = bh;
  v[2 * c] = cl;
  v[2 * c + 1] = ch;
  v[2 * d] = dl;
  v[2 * d + 1] = dh;
}

export interface StreamingDigest {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
}

/** Node's native BLAKE2b-512 when this runtime has one, the JavaScript fallback otherwise. */
export function createBlake2b512(): StreamingDigest {
  if (NodeCrypto.getHashes().includes("blake2b512")) {
    const hash = NodeCrypto.createHash("blake2b512");
    return {
      update: (data) => hash.update(data),
      digest: () => new Uint8Array(hash.digest()),
    };
  }
  return new Blake2b512();
}
