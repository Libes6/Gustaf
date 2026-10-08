import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../lib/api";
import {
  DEFAULT_DEVICE_SETTINGS,
  DEVICE_SETTINGS,
  normalizeDeviceSettings,
  type DeviceSettings,
} from "./deviceSettings";

// Device access settings: loaded once from the `settings` table, saved on every change (same shape as agentSettingsStore).
let current: DeviceSettings = DEFAULT_DEVICE_SETTINGS;
let loading: Promise<DeviceSettings> | undefined;
let edited = false;
const listeners = new Set<() => void>();
const publish = (next: DeviceSettings) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Resolves to the stored settings (the safe defaults when missing or unreadable). */
export function loadDeviceSettings(): Promise<DeviceSettings> {
  loading ??= getSetting<unknown>(DEVICE_SETTINGS, null)
    .then((v) => {
      if (!edited) publish(normalizeDeviceSettings(v));
      return current;
    })
    .catch(() => {
      loading = undefined;
      return current;
    });
  return loading;
}

export const getDeviceSettings = () => current;

export function saveDeviceSettings(next: DeviceSettings) {
  edited = true;
  const clean = normalizeDeviceSettings(next);
  publish(clean);
  setSetting(DEVICE_SETTINGS, clean).catch(() => {});
}

export function useDeviceSettings(): DeviceSettings {
  useEffect(() => void loadDeviceSettings(), []);
  return useSyncExternalStore(subscribe, () => current);
}

/** Test helper: forget the in-memory copy. */
export function resetDeviceSettings() {
  current = DEFAULT_DEVICE_SETTINGS;
  loading = undefined;
  edited = false;
}
