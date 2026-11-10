import type { UiLanguage } from "@t3tools/contracts/settings";
import { useSyncExternalStore } from "react";

// Nearly every component reads the interface language. This store imports nothing
// from the app, so reading it can never pull the settings and connection modules
// into an import cycle. UiLanguageEffect copies the saved setting in.
let current: UiLanguage = "en";
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => current;

export function setUiLanguage(language: UiLanguage) {
  if (language === current) return;
  current = language;
  for (const listener of listeners) listener();
}

export function useUiLanguage(): UiLanguage {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
