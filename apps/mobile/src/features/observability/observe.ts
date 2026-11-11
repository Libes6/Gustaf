// Gustaf has no reporting backend yet. Importing expo-observe itself initializes
// native telemetry and crashes Android without an EAS project ID, even when off.
export const crashReportingAvailable = false;

export function setCrashReportsEnabled(_enabled: boolean): Promise<void> {
  return Promise.resolve();
}
