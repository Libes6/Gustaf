import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { paceElapsedPercent, usedPercentOf } from "@t3tools/shared/usageLimits";

// Gustaf's shared helpers report quota used (desktop bars fill as quota is spent). These
// screens still show quota left, as T3's do, so they derive it from the used figures.
// Converting them to "used" is a separate change.

export function remainingPercent(window: ServerProviderUsageWindow): number {
  return 100 - usedPercentOf(window);
}

/** Share of the window still to come, so even pace reads as quota left. */
export function paceRemainingPercent(
  window: ServerProviderUsageWindow,
  now: number,
): number | null {
  const elapsed = paceElapsedPercent(window, now);
  return elapsed === null ? null : 100 - elapsed;
}
