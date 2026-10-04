import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "./api";
import { AUTO_REVIEW_KEY, DEFAULT_AUTO_REVIEW, normalizeAutoReview, type AutoReviewSettings } from "./autoReview";

// Automatic-review settings (global default, trigger, per-project overrides): loaded once from the `settings` table, saved on every change.
let current: AutoReviewSettings = DEFAULT_AUTO_REVIEW;
let loading: Promise<AutoReviewSettings> | undefined;
let edited = false;
const listeners = new Set<() => void>();
const publish = (next: AutoReviewSettings) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Resolves to the stored settings (defaults, i.e. off, when missing or unreadable). */
export function loadAutoReview(): Promise<AutoReviewSettings> {
  loading ??= getSetting<unknown>(AUTO_REVIEW_KEY, null)
    .then((v) => {
      if (!edited) publish(normalizeAutoReview(v));
      return current;
    })
    .catch(() => {
      loading = undefined;
      return current;
    });
  return loading;
}

export const getAutoReview = () => current;

export function saveAutoReview(next: AutoReviewSettings) {
  edited = true;
  const clean = normalizeAutoReview(next);
  publish(clean);
  setSetting(AUTO_REVIEW_KEY, clean).catch(() => {});
}

export function useAutoReviewSettings(): AutoReviewSettings {
  useEffect(() => void loadAutoReview(), []);
  return useSyncExternalStore(subscribe, () => current);
}

/** Test helper: forget the in-memory copy. */
export function resetAutoReview() {
  current = DEFAULT_AUTO_REVIEW;
  loading = undefined;
  edited = false;
  listeners.forEach((l) => l());
}
