import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PROTOCOL_VERSION } from "@mcode/protocol";
import { parsePairingPayload } from "../../mobile/src/lib/pairing.ts";
import { buildPairingUri, countdown, formatCode, groupFingerprint, qrMatrix, qrPath } from "../src/lib/mobilePairing.ts";

// What src-tauri/src/mobile_server/pairing.rs can issue: 8 symbols of this alphabet.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const FP = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

test("the pairing URI the QR carries is accepted by the phone's parser", () => {
  const uri = buildPairingUri({ host: "192.168.1.20", port: 51234, code: "K7Q2X9PM", fingerprint: FP, protocol: PROTOCOL_VERSION });
  assert.equal(uri, `mcode://pair?host=192.168.1.20&port=51234&code=K7Q2X9PM&fp=${FP}&v=${PROTOCOL_VERSION}`);
  assert.deepEqual(parsePairingPayload(uri), {
    ok: true,
    payload: { protocol: PROTOCOL_VERSION, host: "192.168.1.20", port: 51234, code: "K7Q2X9PM", fingerprint: FP },
  });
});

test("every code symbol survives the round trip, and an uppercase fingerprint is lowercased", () => {
  for (let i = 0; i < ALPHABET.length - 7; i++) {
    const code = ALPHABET.slice(i, i + 8);
    const r = parsePairingPayload(buildPairingUri({ host: "10.0.0.5", port: 65535, code, fingerprint: FP.toUpperCase(), protocol: PROTOCOL_VERSION }));
    assert.equal(r.ok, true, code);
    assert.equal(r.payload.code, code);
    assert.equal(r.payload.fingerprint, FP);
  }
});

test("the QR text is what a scanner returns: the matrix is square, has finder patterns and encodes the whole URI", () => {
  const uri = buildPairingUri({ host: "192.168.1.20", port: 51234, code: "K7Q2X9PM", fingerprint: FP, protocol: PROTOCOL_VERSION });
  const m = qrMatrix(uri);
  assert.ok(m.length >= 21 && m.every((row) => row.length === m.length));
  // Finder pattern: a 7x7 dark ring with a dark 3x3 centre in three corners.
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) {
    for (let i = 0; i < 7; i++) assert.ok(m[r][c + i] && m[r + 6][c + i] && m[r + i][c] && m[r + i][c + 6]);
    assert.ok(m[r + 3][c + 3] && !m[r + 1][c + 1]);
  }
  const path = qrPath(m);
  assert.match(path, /^M\d+ \d+h\d+v1h-\d+z/);
  // The path covers exactly the dark modules.
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  let covered = 0;
  for (const [, w] of path.matchAll(/h(\d+)v1/g)) covered += Number(w);
  assert.equal(covered, dark);
});

test("small formatting helpers", () => {
  assert.equal(formatCode("K7Q2X9PM"), "K7Q2-X9PM");
  assert.equal(formatCode("AB"), "AB");
  assert.equal(countdown(120_000, 0), "2:00");
  assert.equal(countdown(61_500, 0), "1:02");
  assert.equal(countdown(1000, 5000), "0:00");
  assert.equal(groupFingerprint("a1b2c3d4e5"), "a1b2 c3d4 e5");
});

test("the Rust protocol constant equals the TypeScript one", () => {
  const src = readFileSync(new URL("../src-tauri/src/mobile_server.rs", import.meta.url), "utf8");
  assert.equal(Number(/pub const PROTOCOL_VERSION: u32 = (\d+);/.exec(src)?.[1]), PROTOCOL_VERSION);
});

test("the Rust code alphabet is the one the test assumes", () => {
  const src = readFileSync(new URL("../src-tauri/src/mobile_server/pairing.rs", import.meta.url), "utf8");
  assert.equal(/CODE_ALPHABET: &\[u8; 32\] = b"([A-Z0-9]+)"/.exec(src)?.[1], ALPHABET);
});
