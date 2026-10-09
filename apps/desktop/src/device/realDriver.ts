// Builds the real DeviceDriver (simctl, adb, the pinned agent-device helper) and wires it into the app: the Device panel
// reads it through components/device/driverContext.ts, the agent tools through the same driver.

import { appDataDir } from "@tauri-apps/api/path";
import { registerDeviceDriver } from "../components/device/driverContext";
import { createDriver } from "./driver";
import { setDeviceDriver } from "./driverSeam";
import { createShellRunner } from "./shellRunner";

/** Creates the driver once the app data folder is known; nothing is started or installed here. Returns an unwire function. */
export function wireDeviceDriver(): () => void {
  let live = true;
  void appDataDir()
    .then((dir) => {
      if (!live) return;
      // One driver for the panel and for the agent tools: they share its per-device queue and helper sessions.
      const driver = createDriver({ run: createShellRunner(), appDataDir: dir });
      registerDeviceDriver(driver);
      setDeviceDriver(driver);
    })
    .catch(() => {
      /* outside Tauri (tests): the panel shows "not available" */
    });
  return () => {
    live = false;
    registerDeviceDriver(null);
    setDeviceDriver(undefined);
  };
}
