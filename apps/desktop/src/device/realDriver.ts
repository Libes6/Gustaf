// Builds the real DeviceDriver (simctl, adb, the pinned agent-device helper) and wires it into the app: the Device panel
// reads it through components/device/driverContext.ts, the agent tools through the same driver.

import { appDataDir } from "@tauri-apps/api/path";
import { registerDeviceDriver } from "../components/device/driverContext";
import { createDriver } from "./driver";
import { setDeviceDriver } from "./driverSeam";
import { createProcessHelperHost } from "./hostProcess";
import { createShellRunner } from "./shellRunner";

/** Creates the driver once the app data folder is known; nothing is started or installed here. Returns an unwire function. */
export function wireDeviceDriver(): () => void {
  let live = true;
  let closeHost: (() => Promise<void>) | undefined;
  void appDataDir()
    .then((dir) => {
      if (!live) return;
      // One driver for the panel and for the agent tools: they share its per-device queue and helper sessions.
      const run = createShellRunner();
      // One long-lived helper process answers every helper call (no `node agent-device.mjs` per call). It starts on
      // the first call; if it cannot start or keeps failing, the driver falls back to the CLI.
      const host = createProcessHelperHost({ run, dir: `${dir.replace(/[\\/]+$/, "")}/device-helper`, node: "node" });
      closeHost = () => host.close();
      const driver = createDriver({ run, appDataDir: dir, host });
      registerDeviceDriver(driver);
      setDeviceDriver(driver);
    })
    .catch(() => {
      /* outside Tauri (tests): the panel shows "not available" */
    });
  return () => {
    live = false;
    void closeHost?.();
    registerDeviceDriver(null);
    setDeviceDriver(undefined);
  };
}
