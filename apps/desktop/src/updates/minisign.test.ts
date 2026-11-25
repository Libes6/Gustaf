// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off extendsNativeError:off -- The updater is Promise and stream code at the process boundary; its Node I/O is injected in tests.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { Blake2b512 } from "./blake2b.ts";
import {
  MinisignError,
  parsePublicKey,
  parseSignature,
  verifyDigest,
  type MinisignFailure,
} from "./minisign.ts";

const read = (name: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "fixtures", name));

const signerKey = read("signer.pub").toString("utf8");
const otherKey = read("other-signer.pub").toString("utf8");
const digestOf = (bytes: Uint8Array) => new Blake2b512().update(bytes).digest();

const verify = (publicKey: string, signature: string, file: Uint8Array) =>
  verifyDigest(parsePublicKey(publicKey), parseSignature(signature), digestOf(file));

const failureOf = (run: () => void): MinisignFailure | undefined => {
  try {
    run();
  } catch (error) {
    if (error instanceof MinisignError) return error.reason;
    throw error;
  }
  return undefined;
};

describe("minisign verification with signatures made by `tauri signer sign`", () => {
  it.each(["payload.txt", "payload2.txt"])(
    "accepts %s with the key as Tauri configures it",
    (name) => {
      expect(
        failureOf(() => verify(signerKey, read(`${name}.sig`).toString("utf8"), read(name))),
      ).toBeUndefined();
    },
  );

  it("accepts the key as a .pub file and as its bare key line", () => {
    const signature = read("payload.txt.sig").toString("utf8");
    const pubFile = Buffer.from(signerKey, "base64").toString("utf8");
    const keyLine = pubFile.split("\n")[1]!;
    expect(failureOf(() => verify(pubFile, signature, read("payload.txt")))).toBeUndefined();
    expect(failureOf(() => verify(keyLine, signature, read("payload.txt")))).toBeUndefined();
  });

  it("accepts the signature as a .minisig file", () => {
    const text = Buffer.from(read("payload.txt.sig").toString("utf8"), "base64").toString("utf8");
    expect(failureOf(() => verify(signerKey, text, read("payload.txt")))).toBeUndefined();
  });

  it("rejects a file that was swapped for another one", () => {
    const signature = read("payload.txt.sig").toString("utf8");
    expect(failureOf(() => verify(signerKey, signature, read("payload2.txt")))).toBe(
      "bad-signature",
    );
  });

  it("rejects a file with one byte changed", () => {
    const file = Buffer.from(read("payload2.txt"));
    file[1500] = file[1500]! ^ 1;
    expect(
      failureOf(() => verify(signerKey, read("payload2.txt.sig").toString("utf8"), file)),
    ).toBe("bad-signature");
  });

  it("rejects a truncated file", () => {
    const file = read("payload2.txt").subarray(0, 2000);
    expect(
      failureOf(() => verify(signerKey, read("payload2.txt.sig").toString("utf8"), file)),
    ).toBe("bad-signature");
    expect(
      failureOf(() =>
        verify(signerKey, read("payload2.txt.sig").toString("utf8"), new Uint8Array()),
      ),
    ).toBe("bad-signature");
  });

  it("rejects a file with extra bytes appended", () => {
    const file = Buffer.concat([read("payload.txt"), Buffer.from("\n")]);
    expect(failureOf(() => verify(signerKey, read("payload.txt.sig").toString("utf8"), file))).toBe(
      "bad-signature",
    );
  });

  it("rejects a signature from another key", () => {
    expect(
      failureOf(() =>
        verify(otherKey, read("payload.txt.sig").toString("utf8"), read("payload.txt")),
      ),
    ).toBe("key-id-mismatch");
  });

  it("rejects a public key whose id matches but whose key bytes differ", () => {
    const pub = Buffer.from(
      Buffer.from(signerKey, "base64").toString("utf8").split("\n")[1]!,
      "base64",
    );
    pub[20] = pub[20]! ^ 0xff;
    expect(
      failureOf(() =>
        verify(
          pub.toString("base64"),
          read("payload.txt.sig").toString("utf8"),
          read("payload.txt"),
        ),
      ),
    ).toBe("bad-signature");
  });

  it("rejects an altered trusted comment", () => {
    const text = Buffer.from(read("payload.txt.sig").toString("utf8"), "base64")
      .toString("utf8")
      .replace("file:payload.txt", "file:evil.txt");
    expect(failureOf(() => verify(signerKey, text, read("payload.txt")))).toBe(
      "bad-trusted-comment",
    );
  });

  it("rejects an altered signature body", () => {
    const lines = Buffer.from(read("payload.txt.sig").toString("utf8"), "base64")
      .toString("utf8")
      .split("\n");
    const raw = Buffer.from(lines[1]!, "base64");
    raw[40] = raw[40]! ^ 1;
    lines[1] = raw.toString("base64");
    expect(failureOf(() => verify(signerKey, lines.join("\n"), read("payload.txt")))).toBe(
      "bad-signature",
    );
  });

  it("rejects legacy unhashed signatures and garbage", () => {
    const lines = Buffer.from(read("payload.txt.sig").toString("utf8"), "base64")
      .toString("utf8")
      .split("\n");
    const raw = Buffer.from(lines[1]!, "base64");
    raw.write("Ed", 0, "latin1");
    lines[1] = raw.toString("base64");
    expect(failureOf(() => parseSignature(lines.join("\n")))).toBe("legacy-signature");
    expect(failureOf(() => parseSignature("not a signature"))).toBe("bad-signature-format");
    expect(failureOf(() => parseSignature(""))).toBe("bad-signature-format");
    expect(failureOf(() => parsePublicKey("garbage"))).toBe("bad-public-key");
    expect(failureOf(() => parsePublicKey(""))).toBe("bad-public-key");
  });
});
