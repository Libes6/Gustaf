import { useAtomValue } from "@effect/atom-react";
import type { UsageLimitsDisplay } from "@t3tools/contracts/settings";
import { DEFAULT_USAGE_LIMITS_DISPLAY } from "@t3tools/shared/usageLimitsDisplay";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";

export function useUsageLimitsDisplay(): UsageLimitsDisplay {
  const preferences = useAtomValue(mobilePreferencesAtom);
  return AsyncResult.isSuccess(preferences)
    ? (preferences.value.usageLimitsDisplay ?? DEFAULT_USAGE_LIMITS_DISPLAY)
    : DEFAULT_USAGE_LIMITS_DISPLAY;
}
