// Pixel size of a PNG or JPEG from its first bytes: the live frame carries its size without decoding the picture.
// Pure, no I/O. Works on a truncated file as long as the header is there (PNG: first 24 bytes, JPEG: until SOF).

import type { Size } from "./uiMap";

export type ImageInfo = { mime: "image/png" | "image/jpeg"; size: Size };

const b64 = (data: string, bytes = 4096) => {
  const head = data.slice(0, Math.ceil((bytes * 4) / 3) + 4);
  return Uint8Array.from(atob(head.slice(0, head.length - (head.length % 4))), (c) => c.charCodeAt(0));
};

/** The mime type and pixel size of a base64 PNG or JPEG; null when it is neither. */
export function imageInfo(base64: string): ImageInfo | null {
  const b = b64(base64);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    return { mime: "image/png", size: { width: u32(16), height: u32(20) } };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return { mime: "image/jpeg", size: { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] } };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
  }
  return null;
}
