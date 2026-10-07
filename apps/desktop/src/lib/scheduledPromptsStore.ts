import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "./api";
import {
  normalizeScheduled,
  recoverInterrupted,
  SCHEDULED_PROMPTS_SETTING,
  type ScheduledPrompt,
} from "./scheduledPrompts";

// The list of schedules, shared in memory (the runner patches it from background runs while the settings page edits it)
// and saved to the `settings` table after every change. Loading marks runs that were active at shutdown as interrupted.
let current: ScheduledPrompt[] = [];
let loaded = false;
let loading: Promise<ScheduledPrompt[]> | undefined;
let edited = false;
const listeners = new Set<() => void>();
const publish = (next: ScheduledPrompt[]) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Resolves to the stored schedules (an empty list when missing or unreadable). */
export function loadScheduled(): Promise<ScheduledPrompt[]> {
  loading ??= getSetting<unknown>(SCHEDULED_PROMPTS_SETTING, [])
    .then((raw) => {
      // An edit made before the load finished wins; stored data never replaces it.
      if (!edited) publish(recoverInterrupted(normalizeScheduled(raw)));
      loaded = true;
      return current;
    })
    .catch(() => {
      loading = undefined;
      return current;
    });
  return loading;
}

export const getScheduled = () => current;
/** Called after every change of the list (runner patches included). */
export const subscribeScheduled = subscribe;
export const isScheduledLoaded = () => loaded;

/** Replaces the list through `fn` (given the latest list, so concurrent patches do not overwrite each other) and saves it. */
export function updateScheduled(fn: (list: ScheduledPrompt[]) => ScheduledPrompt[]) {
  // Before the stored list is loaded an edit would overwrite it with an empty one.
  if (!loaded) return;
  edited = true;
  const next = normalizeScheduled(fn(current));
  publish(next);
  setSetting(SCHEDULED_PROMPTS_SETTING, next).catch(() => {});
}

export function useScheduled(): ScheduledPrompt[] {
  useEffect(() => void loadScheduled(), []);
  return useSyncExternalStore(subscribe, () => current);
}

/** Test helper: forget the in-memory copy. */
export function resetScheduled() {
  current = [];
  loaded = false;
  loading = undefined;
  edited = false;
}
