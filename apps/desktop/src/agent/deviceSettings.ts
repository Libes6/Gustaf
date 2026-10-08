// Pure settings of the agent's device access (Settings > Computer use > Devices), stored per install in the app
// `settings` table under "deviceAgent" (deviceSettingsStore.ts). Off by default.

export const DEVICE_SETTINGS = "deviceAgent";

export type DeviceSettings = {
  /** Agents may use simulators and emulators (device_* tools; the `gustaf-device` command for CLI agents). */
  access: boolean;
  /** Ask the user the first time an agent uses a device in a chat. Destructive actions always ask. */
  askFirst: boolean;
};

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = { access: false, askFirst: true };

/** Anything unreadable falls back to the safe default of that field. */
export function normalizeDeviceSettings(raw: unknown): DeviceSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    access: r.access === true,
    askFirst: r.askFirst !== false,
  };
}
