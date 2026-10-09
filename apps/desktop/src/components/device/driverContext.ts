// The seam between the Device panel and the real driver. The driver is written by someone else (src/device/driver*.ts)
// and wired in at one place: either `registerDeviceDriver(driver)` at startup or a `DeviceDriverContext.Provider`.
// Tests inject the fake driver (src/device/fakeDriver.ts) through the provider or the `driver` prop of the panel.
// With neither, the panel shows a clear "not available" state instead of failing.

import { createContext, useContext } from "react";
import type { DeviceDriver } from "../../device/types";

let registered: DeviceDriver | null = null;

/** Wires the app-wide driver. Pass null to unwire it. */
export function registerDeviceDriver(driver: DeviceDriver | null) {
  registered = driver;
}

/** The app-wide driver, or null when none is wired. */
export function getDeviceDriver(): DeviceDriver | null {
  return registered;
}

/** `undefined` = nothing provided, fall back to `getDeviceDriver()`; `null` = explicitly no driver. */
export const DeviceDriverContext = createContext<DeviceDriver | null | undefined>(undefined);

export function useDeviceDriver(): DeviceDriver | null {
  const provided = useContext(DeviceDriverContext);
  return provided === undefined ? getDeviceDriver() : provided;
}
