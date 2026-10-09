// The one place the agent tools get a DeviceDriver from. The tools are written against the contract in types.ts and never
// import a concrete driver; the app's startup code installs the real one with `setDeviceDriver`, tests install a fake.

import type { DeviceDriver } from "./types";

let current: DeviceDriver | undefined;

/** Installs the driver the agent tools use (`undefined` removes it). */
export function setDeviceDriver(driver: DeviceDriver | undefined) {
  current = driver;
}

/** The installed driver. Throws a plain error (a tool error for the model) when none was installed. */
export function getDeviceDriver(): DeviceDriver {
  if (!current) throw new Error("Device driver not available");
  return current;
}

export const hasDeviceDriver = () => !!current;
