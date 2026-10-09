// Reading what the `agent-device` helper prints with `--json`, and turning its failures into DeviceError codes.
// Pure, no I/O. The shapes come from real runs of agent-device 0.21.23 (tests/fixtures/device-ios-helper.json).

import { DeviceError } from "./types";

export type HelperError = { code?: string; message: string; hint?: string; reason?: string };
/** The `data` of a reply: only the fields the driver reads are typed. */
export type HelperData = {
  message?: string;
  appName?: string;
  appBundleId?: string;
  nodes?: unknown[];
  warnings?: unknown;
  settle?: HelperSettle;
  [key: string]: unknown;
};
export type HelperSettle = {
  settled?: boolean;
  diff?: {
    summary?: { additions?: number; removals?: number; unchanged?: number };
    lines?: { kind?: string; text?: string }[];
  };
};
export type HelperReply = { ok: true; data: HelperData } | { ok: false; error: HelperError };

/** The JSON object in the helper's stdout (it may print a banner line first). Null when there is none. */
export function parseHelperReply(stdout: string): HelperReply | null {
  const s = stdout.trim();
  let raw: {
    success?: boolean;
    data?: unknown;
    error?: Record<string, unknown> & { details?: { reason?: unknown } };
  } | null = null;
  const at = s.indexOf("{");
  if (at < 0) return null;
  for (const candidate of at === 0 ? [s] : [s, s.slice(at)]) {
    try {
      raw = JSON.parse(candidate);
      break;
    } catch {
      /* try the next shape */
    }
  }
  if (!raw || typeof raw !== "object") return null;
  if (raw.success === true)
    return { ok: true, data: raw.data && typeof raw.data === "object" ? (raw.data as HelperData) : {} };
  const e = raw.error ?? {};
  return {
    ok: false,
    error: {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : "The device helper failed.",
      hint: typeof e.hint === "string" ? e.hint : undefined,
      reason: typeof e.details?.reason === "string" ? e.details.reason : undefined,
    },
  };
}

const REF = /\bref\b|@e\d+/i;

/** The helper rejected a ref: it is from an older snapshot, or was never issued. */
export const isStaleRef = (e: HelperError) =>
  /ref/i.test(e.reason ?? "") ||
  /REF/.test(e.code ?? "") ||
  (REF.test(e.message) &&
    /needs a complete snapshot|stale|expired|not found|unknown|no longer|invalid|not in the current/i.test(e.message));

/** A DeviceError for a failed helper call, with the code a caller can act on. */
export function helperFailure(e: HelperError): DeviceError {
  const text = e.message + (e.hint ? ` ${e.hint}` : "");
  if (isStaleRef(e))
    return new DeviceError(
      "That element is no longer on the screen. Take a new snapshot and use its refs.",
      "stale-ref",
    );
  if (/TIMEOUT|TIMED_OUT/i.test(e.code ?? "") || /timed out|timeout/i.test(e.message))
    return new DeviceError(e.message, "timeout");
  if (
    e.code === "DEVICE_NOT_FOUND" ||
    /no (such )?device|device not found|no devices? (found|matched)/i.test(e.message)
  )
    return new DeviceError(e.message, "no-device");
  if (e.code === "DEVICE_IN_USE")
    return new DeviceError(
      `Another automation session holds this device. ${e.hint ?? "Close that session first."}`,
      "failed",
    );
  if (
    /xcrun|xcode|simctl|adb: |adb not found|ANDROID_HOME/i.test(text) &&
    /not found|unable|missing|install/i.test(text)
  )
    return new DeviceError(e.message, "toolchain");
  return new DeviceError(e.message, "failed");
}
