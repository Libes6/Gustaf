// The contract between the device driver (talks to simulators and emulators), the Device panel and the agent tools.
// Each of them is written against this file; tests use a fake driver (src/device/fakeDriver.ts).

import type { Size, UiMap } from "./uiMap";

export type DevicePlatform = "ios" | "android";
export type DeviceState = "booted" | "booting" | "shutdown" | "unknown";

export type DeviceInfo = {
  /** Simulator UDID or emulator serial: what every call takes. */
  id: string;
  name: string;
  platform: DevicePlatform;
  state: DeviceState;
  /** "iOS 26.2", "Android 15"... when known. */
  os?: string;
};

export type ToolchainStatus = {
  /** Can this platform be used at all (Xcode command line tools / adb found). */
  available: boolean;
  /** Why not, in one sentence a person can act on. */
  reason?: string;
};

export type DeviceToolchain = {
  ios: ToolchainStatus;
  android: ToolchainStatus;
  /** The pinned `agent-device` helper that taps, types and reads the accessibility tree. Installed only on request. */
  helper: { installed: boolean; version?: string; pinned: string };
};

export type Point = { x: number; y: number };

/** What to act on: an element of the last snapshot, or a point in device points (the last resort). */
export type Target = { ref: string } | { x: number; y: number };

export type PressKey = "home" | "back" | "enter" | "app-switcher" | "volume-up" | "volume-down";

export type ActionResult = {
  /** One line, e.g. `Tapped @e7 (201, 355)`. */
  message: string;
  /** What changed on screen afterwards, as text (src/device/uiMap.ts `renderDiff`); empty when nothing did. */
  diff: string;
  /** The screen did settle (no change for a short while) before the call returned. */
  settled: boolean;
};

export type Frame = {
  /** Base64, no data: prefix. */
  data: string;
  mime: "image/png" | "image/jpeg";
  /** Pixels of the image. */
  pixels: Size;
  /** The screen in device points (the unit of every Target and UiNode rect). */
  points: Size;
};

export interface DeviceDriver {
  toolchain(): Promise<DeviceToolchain>;
  /** Installs the pinned helper into the app's own folder. Only ever called after an explicit user action. */
  installHelper(onProgress?: (line: string) => void): Promise<void>;
  list(): Promise<DeviceInfo[]>;
  boot(id: string): Promise<void>;
  /** Powers the device off. */
  shutdown(id: string): Promise<void>;
  /** A fast picture for the live view (no accessibility work). */
  frame(id: string): Promise<Frame>;
  /** The interface map of the foreground app. */
  snapshot(id: string): Promise<UiMap>;
  tap(id: string, target: Target): Promise<ActionResult>;
  longPress(id: string, target: Target, ms?: number): Promise<ActionResult>;
  swipe(id: string, from: Point, to: Point, ms?: number): Promise<ActionResult>;
  /** Appends text to the focused field. */
  type(id: string, text: string): Promise<ActionResult>;
  /** Replaces the text of a field. */
  fill(id: string, target: Target, text: string): Promise<ActionResult>;
  press(id: string, key: PressKey): Promise<ActionResult>;
  scroll(id: string, direction: "up" | "down" | "left" | "right", amount?: number): Promise<ActionResult>;
  /** Launches an app by name or bundle id and brings it to the front. */
  openApp(id: string, app: string): Promise<ActionResult>;
  /** Ends this app's automation session for the device (the device keeps running). */
  release(id: string): Promise<void>;
}

/** Thrown by drivers; `code` lets callers show a specific message. */
export class DeviceError extends Error {
  constructor(
    message: string,
    readonly code: "toolchain" | "helper-missing" | "no-device" | "stale-ref" | "timeout" | "failed" = "failed",
  ) {
    super(message);
  }
}
