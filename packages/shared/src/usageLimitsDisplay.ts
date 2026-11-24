import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import type { UsageLimitsDisplay } from "@t3tools/contracts/settings";

import { paceRemainingPercent, remainingPercent } from "./usageLimits.ts";

/** Matches what limit widgets showed before the setting existed. */
export const DEFAULT_USAGE_LIMITS_DISPLAY: UsageLimitsDisplay = "used";

/** Turns a rounded remaining percentage into the number the chosen mode shows and fills. */
export function displayedPercent(remaining: number, mode: UsageLimitsDisplay): number {
  return mode === "used" ? 100 - remaining : remaining;
}

export function windowDisplayPercent(
  window: ServerProviderUsageWindow,
  mode: UsageLimitsDisplay,
): number {
  return displayedPercent(remainingPercent(window), mode);
}

/** Where even spending sits on the bar: the share of the window gone, or the share still ahead. */
export function paceDisplayPercent(
  window: ServerProviderUsageWindow,
  now: number,
  mode: UsageLimitsDisplay,
): number | null {
  const timeLeft = paceRemainingPercent(window, now);
  return timeLeft === null ? null : displayedPercent(timeLeft, mode);
}
