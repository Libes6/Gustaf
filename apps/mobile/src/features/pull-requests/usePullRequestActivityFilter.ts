import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { DEFAULT_ACTIVITY_FILTER, type ActivityFilter } from "./pullRequestActivityFilter";

/** Bot and resolved visibility is a saved preference; kind and order stay with this screen. */
export function usePullRequestActivityFilter() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [view, setView] = useState({
    kind: DEFAULT_ACTIVITY_FILTER.kind,
    newestFirst: DEFAULT_ACTIVITY_FILTER.newestFirst,
  });
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestActivityVisibility
    : undefined;
  const visibility = saved ?? DEFAULT_ACTIVITY_FILTER;
  const filter: ActivityFilter = {
    kind: view.kind,
    newestFirst: view.newestFirst,
    bots: visibility.bots,
    resolved: visibility.resolved,
  };
  return {
    filter,
    setFilter: (next: ActivityFilter) => {
      if (next.bots !== filter.bots || next.resolved !== filter.resolved) {
        savePreferences({
          pullRequestActivityVisibility: { bots: next.bots, resolved: next.resolved },
        });
      }
      setView({ kind: next.kind, newestFirst: next.newestFirst });
    },
  };
}
