import type { Wakeups } from "@t3tools/client-runtime/connection";

const MOBILE_LONG_BACKGROUND_AFTER_MS = 10_000;

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

/**
 * `keptAliveSinceMs` is when the Android keep-connection service started, or null. A service
 * that ran the whole time kept the socket and its pings going, so the return is a plain probe.
 */
export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
  keptAliveSinceMs: number | null = null,
): MobileApplicationActiveWakeup {
  if (backgroundedAtMs === null) return "application-active-probe";
  if (keptAliveSinceMs !== null && keptAliveSinceMs <= backgroundedAtMs) {
    return "application-active-probe";
  }
  return activeAtMs - backgroundedAtMs >= MOBILE_LONG_BACKGROUND_AFTER_MS
    ? "application-active-long"
    : "application-active-probe";
}
