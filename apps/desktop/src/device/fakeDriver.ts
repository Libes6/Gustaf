// An in-memory DeviceDriver for tests of the panel and the agent tools: a few devices, a settable map and frame, and a
// log of every call.

import { parseSnapshot, type UiMap } from "./uiMap";
import {
  DeviceError,
  type ActionResult,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceToolchain,
  type Frame,
} from "./types";

export type FakeCall = { method: string; args: unknown[] };

export function createFakeDriver(
  o: { devices?: DeviceInfo[]; map?: UiMap; toolchain?: Partial<DeviceToolchain> } = {},
) {
  const devices: DeviceInfo[] = o.devices ?? [
    { id: "SIM-1", name: "iPhone 17 Pro", platform: "ios", state: "booted", os: "iOS 26.2" },
    { id: "SIM-2", name: "iPhone 16e", platform: "ios", state: "shutdown", os: "iOS 26.2" },
  ];
  const calls: FakeCall[] = [];
  const state = {
    map: o.map ?? parseSnapshot({ viewport: { width: 402, height: 874 }, nodes: [] }),
    failNext: undefined as string | undefined,
  };
  const frame: Frame = {
    data: "iVBORw0KGgo=",
    mime: "image/png",
    pixels: { width: 804, height: 1748 },
    points: { width: 402, height: 874 },
  };
  const ok = (message: string): ActionResult => ({ message, diff: "", settled: true });
  const rec = <T>(method: string, args: unknown[], value: () => T): Promise<T> => {
    calls.push({ method, args });
    if (state.failNext) {
      const m = state.failNext;
      state.failNext = undefined;
      return Promise.reject(new DeviceError(m));
    }
    return Promise.resolve(value());
  };
  const driver: DeviceDriver = {
    toolchain: () =>
      rec("toolchain", [], () => ({
        ios: { available: true },
        android: { available: false, reason: "adb not found" },
        helper: { installed: true, version: "0.0.0", pinned: "0.0.0" },
        ...o.toolchain,
      })),
    installHelper: (p) => rec("installHelper", [], () => void p?.("installed")),
    list: () => rec("list", [], () => devices.map((d) => ({ ...d }))),
    boot: (id) =>
      rec("boot", [id], () => {
        const d = devices.find((x) => x.id === id);
        if (!d) throw new DeviceError("No such device", "no-device");
        d.state = "booted";
      }),
    shutdown: (id) =>
      rec("shutdown", [id], () => {
        const d = devices.find((x) => x.id === id);
        if (d) d.state = "shutdown";
      }),
    frame: (id) => rec("frame", [id], () => frame),
    snapshot: (id) => rec("snapshot", [id], () => state.map),
    tap: (id, t) => rec("tap", [id, t], () => ok("Tapped")),
    longPress: (id, t, ms) => rec("longPress", [id, t, ms], () => ok("Long pressed")),
    swipe: (id, a, b, ms) => rec("swipe", [id, a, b, ms], () => ok("Swiped")),
    type: (id, text) => rec("type", [id, text], () => ok("Typed")),
    fill: (id, t, text) => rec("fill", [id, t, text], () => ok("Filled")),
    press: (id, k) => rec("press", [id, k], () => ok(`Pressed ${k}`)),
    scroll: (id, d, a) => rec("scroll", [id, d, a], () => ok(`Scrolled ${d}`)),
    openApp: (id, app) => rec("openApp", [id, app], () => ok(`Opened ${app}`)),
    release: (id) => rec("release", [id], () => undefined),
  };
  return { driver, calls, devices, state };
}
