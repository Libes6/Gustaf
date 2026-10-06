import { PROTOCOL_VERSION, type PairingQrPayload } from "@mcode/protocol";

/** Why a scanned or pasted pairing payload was rejected; each code maps to a translated message (`pairError.<code>`). */
export type PairingErrorCode =
  | "empty"
  | "unrecognized"
  | "invalid_json"
  | "missing_field"
  | "invalid_host"
  | "invalid_port"
  | "invalid_code"
  | "invalid_fingerprint"
  | "unsupported_version";

export type PairingParseResult =
  | { ok: true; payload: PairingQrPayload }
  | { ok: false; error: PairingErrorCode; field?: string };

const fail = (error: PairingErrorCode, field?: string): PairingParseResult => ({ ok: false, error, field });

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^[0-9A-Fa-f:.]{2,45}$/;
const CODE = /^[A-Za-z0-9_-]{4,64}$/;

/** Accepts a hostname, an IPv4 address or an IPv6 address (optionally in brackets); returns it without brackets. */
export function normalizeHost(raw: string): string | null {
  const host = raw.trim();
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    return inner.includes(":") && IPV6.test(inner) ? inner : null;
  }
  if (host.includes(":")) return IPV6.test(host) ? host : null;
  return HOSTNAME.test(host) ? host : null;
}

/** SHA-256 fingerprint as 64 hex characters; colon or space separators and any case are accepted. Returns lowercase hex. */
export function normalizeFingerprint(raw: string): string | null {
  const hex = raw.trim().replace(/[:\s]/g, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function validate(raw: Record<string, unknown>): PairingParseResult {
  const need = (k: string): unknown => {
    const v = raw[k];
    return v === undefined || v === null || v === "" ? undefined : v;
  };

  const rawHost = need("host");
  if (rawHost === undefined) return fail("missing_field", "host");
  const host = typeof rawHost === "string" ? normalizeHost(rawHost) : null;
  if (!host) return fail("invalid_host", "host");

  const rawPort = need("port");
  if (rawPort === undefined) return fail("missing_field", "port");
  const portNum = typeof rawPort === "number" ? rawPort : typeof rawPort === "string" && /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return fail("invalid_port", "port");

  const rawCode = need("code");
  if (rawCode === undefined) return fail("missing_field", "code");
  if (typeof rawCode !== "string" || !CODE.test(rawCode)) return fail("invalid_code", "code");

  const rawFp = need("fingerprint") ?? need("fp");
  if (rawFp === undefined) return fail("missing_field", "fingerprint");
  const fingerprint = typeof rawFp === "string" ? normalizeFingerprint(rawFp) : null;
  if (!fingerprint) return fail("invalid_fingerprint", "fingerprint");

  const rawV = need("v") ?? need("protocol");
  if (rawV === undefined) return fail("missing_field", "v");
  const v = typeof rawV === "number" ? rawV : typeof rawV === "string" && /^\d{1,4}$/.test(rawV) ? Number(rawV) : NaN;
  if (v !== PROTOCOL_VERSION) return fail("unsupported_version", "v");

  return { ok: true, payload: { protocol: v, host, port: portNum, code: rawCode, fingerprint } };
}

/**
 * Parses what the QR scanner (or a paste box) delivers: either `gustaf://pair?host=..&port=..&code=..&fingerprint=..&v=1`
 * (`fp` is accepted for `fingerprint`, `protocol` for `v`; the `mcode://` scheme of builds from before the rename too) or the JSON `{ host, port, code, fingerprint, v }`.
 * Pure: no network, no React.
 */
export function parsePairingPayload(input: string): PairingParseResult {
  const text = input.trim();
  if (!text) return fail("empty");

  if (text.startsWith("{")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return fail("invalid_json");
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) return fail("invalid_json");
    return validate(json as Record<string, unknown>);
  }

  const m = /^(?:gustaf|mcode):\/\/pair\/?\?(.*)$/i.exec(text);
  if (m) {
    const params: Record<string, unknown> = {};
    for (const pair of (m[1] ?? "").split("&")) {
      if (!pair) continue;
      const i = pair.indexOf("=");
      const key = i < 0 ? pair : pair.slice(0, i);
      let value = "";
      try {
        value = i < 0 ? "" : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, " "));
      } catch {
        return fail("unrecognized");
      }
      params[key] = value;
    }
    return validate(params);
  }

  return fail("unrecognized");
}

/** Short form for display: first and last 4 bytes of the fingerprint. */
export function shortFingerprint(hex: string): string {
  return hex.length >= 16 ? `${hex.slice(0, 8)}…${hex.slice(-8)}` : hex;
}
