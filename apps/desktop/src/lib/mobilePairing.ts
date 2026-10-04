// Pure helpers of the Settings > Mobile page (no React, no Tauri): the pairing URI the QR code carries, the code as shown to
// people, the countdown text and the QR matrix. The URI must stay parseable by `parsePairingPayload` in apps/mobile/src/lib/pairing.ts
// (tests/mobilePairing.test.mjs checks exactly that). The QR encoder runs locally, nothing touches the network.
import qrcode from "qrcode-generator";

export type PairingParts = { host: string; port: number; code: string; fingerprint: string; protocol: number };

/** `mcode://pair?host=…&port=…&code=…&fp=<sha256 hex>&v=<protocol version>` */
export function buildPairingUri(p: PairingParts): string {
  const q = (v: string | number) => encodeURIComponent(String(v));
  return `mcode://pair?host=${q(p.host)}&port=${q(p.port)}&code=${q(p.code)}&fp=${q(p.fingerprint.toLowerCase())}&v=${q(p.protocol)}`;
}

/** `K7Q2X9PM` is shown as `K7Q2-X9PM` (the server accepts it with or without the dash, in any case). */
export function formatCode(code: string): string {
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** `m:ss` for the time left; never negative. */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The fingerprint in groups of four for reading aloud / comparing: `a1b2 c3d4 …`. */
export function groupFingerprint(hex: string): string {
  return hex.replace(/(.{4})(?=.)/g, "$1 ");
}

/** QR modules (true = dark), error correction level M, smallest version that fits. */
export function qrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** One SVG path for all dark modules (1 unit per module); the page draws it with a 4-module quiet zone around it. */
export function qrPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
      x = end;
    }
  });
  return parts.join("");
}
