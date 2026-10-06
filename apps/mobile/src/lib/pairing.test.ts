import assert from "node:assert/strict";
import { test } from "node:test";
import { PROTOCOL_VERSION } from "@gustaf/protocol";
import { normalizeFingerprint, normalizeHost, parsePairingPayload, shortFingerprint } from "./pairing.ts";

const FP = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const good = { host: "192.168.1.20", port: 8443, code: "K7Q2-X9PM", fingerprint: FP, v: PROTOCOL_VERSION };

test("parses a JSON payload", () => {
  const r = parsePairingPayload(JSON.stringify(good));
  assert.deepEqual(r, {
    ok: true,
    payload: { protocol: PROTOCOL_VERSION, host: "192.168.1.20", port: 8443, code: "K7Q2-X9PM", fingerprint: FP },
  });
});

test("parses a gustaf:// URL, with fp alias, colons and uppercase in the fingerprint", () => {
  const colon = FP.toUpperCase().match(/../g)!.join(":");
  const r = parsePairingPayload(`gustaf://pair?host=my-mac.local&port=9000&code=abcd1234&fp=${encodeURIComponent(colon)}&v=1`);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.payload.host, "my-mac.local");
    assert.equal(r.payload.port, 9000);
    assert.equal(r.payload.fingerprint, FP);
  }
});

test("accepts `protocol` as an alias of `v`, string ports and bracketed IPv6", () => {
  const r = parsePairingPayload(JSON.stringify({ ...good, v: undefined, protocol: 1, port: "8443", host: "[fe80::1]" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.payload.host, "fe80::1");
});

test("surrounding whitespace is ignored", () => {
  assert.equal(parsePairingPayload(`  \n${JSON.stringify(good)}\n`).ok, true);
});

test("rejects bad input with a specific code", () => {
  const code = (s: string) => {
    const r = parsePairingPayload(s);
    return r.ok ? "ok" : r.error;
  };
  assert.equal(code(""), "empty");
  assert.equal(code("https://example.com"), "unrecognized");
  assert.equal(code("{nope"), "invalid_json");
  assert.equal(code("[1,2]"), "unrecognized");
  assert.equal(code(JSON.stringify({ ...good, host: undefined })), "missing_field");
  assert.equal(code(JSON.stringify({ ...good, host: "bad host!" })), "invalid_host");
  assert.equal(code(JSON.stringify({ ...good, port: 0 })), "invalid_port");
  assert.equal(code(JSON.stringify({ ...good, port: 70000 })), "invalid_port");
  assert.equal(code(JSON.stringify({ ...good, port: 80.5 })), "invalid_port");
  assert.equal(code(JSON.stringify({ ...good, code: "ab" })), "invalid_code");
  assert.equal(code(JSON.stringify({ ...good, fingerprint: "abc" })), "invalid_fingerprint");
  assert.equal(code(JSON.stringify({ ...good, v: PROTOCOL_VERSION + 1 })), "unsupported_version");
  assert.equal(code(JSON.stringify({ ...good, v: undefined })), "missing_field");
  assert.equal(code("gustaf://pair?host=a&port=1"), "missing_field");
  // The scheme of desktop builds from before the rename.
  assert.equal(parsePairingPayload(`mcode://pair?host=a&port=1&code=abcd1234&fp=${FP}&v=${PROTOCOL_VERSION}`).ok, true);
});

test("reports the offending field", () => {
  const r = parsePairingPayload(JSON.stringify({ ...good, port: "x" }));
  assert.deepEqual(r, { ok: false, error: "invalid_port", field: "port" });
});

test("helpers", () => {
  assert.equal(normalizeHost("Example.com"), "Example.com");
  assert.equal(normalizeHost("-bad.com"), null);
  assert.equal(normalizeFingerprint(FP.slice(2)), null);
  assert.equal(shortFingerprint(FP), `${FP.slice(0, 8)}…${FP.slice(-8)}`);
});
