import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";

export const MODEL_PICKER_REFRESH_INTERVAL_MS = 10_000;

/**
 * Picks the instances an opening picker should re-probe and stamps them, so reopening within the
 * interval sends nothing.
 */
export function takeModelPickerRefreshTargets(
  lastRefreshedAt: Map<string, number>,
  input: {
    readonly environmentId: EnvironmentId;
    readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
    readonly now: number;
  },
): ReadonlyArray<ProviderInstanceId> {
  return input.instanceIds.filter((instanceId) => {
    const key = `${input.environmentId}\u0000${instanceId}`;
    const last = lastRefreshedAt.get(key);
    if (last !== undefined && input.now - last < MODEL_PICKER_REFRESH_INTERVAL_MS) return false;
    lastRefreshedAt.set(key, input.now);
    return true;
  });
}
