// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- The updater is Promise and stream code at the process boundary; its Node I/O is injected in tests.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { Blake2b512, createBlake2b512 } from "./blake2b.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("Blake2b512", () => {
  it("matches the RFC 7693 vector for abc", () => {
    expect(hex(new Blake2b512().update(Buffer.from("abc")).digest())).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
  });

  it("matches the empty-input vector", () => {
    expect(hex(new Blake2b512().digest())).toBe(
      "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce",
    );
  });

  it.each([1, 127, 128, 129, 255, 256, 257, 1000, 4096, 100_003])(
    "agrees with Node's native hash for %i bytes, however the input is chunked",
    (length) => {
      const data = NodeCrypto.randomBytes(length);
      const expected = hex(NodeCrypto.createHash("blake2b512").update(data).digest());
      expect(hex(new Blake2b512().update(data).digest())).toBe(expected);

      const chunked = new Blake2b512();
      for (let offset = 0; offset < length; offset += 37) {
        chunked.update(data.subarray(offset, offset + 37));
      }
      expect(hex(chunked.digest())).toBe(expected);
    },
  );

  it("refuses to be used after the digest", () => {
    const hash = new Blake2b512();
    hash.digest();
    expect(() => hash.update(Buffer.from("x"))).toThrow();
    expect(() => hash.digest()).toThrow();
  });

  it("gives the same digest through the runtime's own hash", () => {
    const data = Buffer.from("same digest either way");
    const hash = createBlake2b512();
    hash.update(data);
    expect(hex(hash.digest())).toBe(hex(new Blake2b512().update(data).digest()));
  });
});
