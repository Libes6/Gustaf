export type KeepConnectionState =
  /** Not Android, or a build without the native service. */
  | "unsupported"
  | "off"
  /** Turned on, but notifications are off, so Android would hide why the app keeps running. */
  | "needs-permission"
  /** Turned on with nothing to keep connected. */
  | "idle"
  | "on";

export function keepConnectionState(input: {
  readonly supported: boolean;
  readonly enabled: boolean;
  readonly notificationsAllowed: boolean;
  readonly environmentCount: number;
}): KeepConnectionState {
  if (!input.supported) return "unsupported";
  if (!input.enabled) return "off";
  if (!input.notificationsAllowed) return "needs-permission";
  return input.environmentCount > 0 ? "on" : "idle";
}
