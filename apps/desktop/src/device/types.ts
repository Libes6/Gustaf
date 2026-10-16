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

export type SnapshotOptions = {
  /**
   * A refresh for the interface pane, not something a person or an agent waits for: if an action is queued first and
   * this snapshot has not started yet, it is skipped and the last known map is returned.
   */
  background?: boolean;
};

/**
 * The input calls of a person at the panel: dispatched at once, without waiting for the screen to settle and without
 * a snapshot afterwards (`diff` is empty, `settled` is true). The agent tools use the verified methods of
 * `DeviceDriver` itself. Same order guarantees: calls for one device run one after another.
 */
export type HumanInput = Pick<DeviceDriver, "tap" | "longPress" | "swipe" | "type" | "fill" | "press" | "scroll"> & {
  /**
   * One raw touch event (down, move, up) at a device point, so a drag follows the pointer like a finger. Returns true
   * when the event was handed to the device; false means "not supported here, use tap / swipe at the end of the
   * gesture instead" (then nothing was sent). Never waits for the device.
   */
  touch?(id: string, phase: "down" | "move" | "up", at: Point): boolean;
};

export interface DeviceDriver {
  /** Fast input for the Device panel; a driver without it is used as is. */
  human?: HumanInput;
  /**
   * The device pushes frames and `frame()` returns the next changed one (waiting for it): the caller should ask again
   * at once instead of polling on a timer.
   */
  streaming?(id: string): boolean;
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
  snapshot(id: string, opts?: SnapshotOptions): Promise<UiMap>;
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

export type DeviceErrorCode = "toolchain" | "helper-missing" | "no-device" | "stale-ref" | "timeout" | "failed";

/** Thrown by drivers; `code` lets callers show a specific message. */
export class DeviceError extends Error {
  // Declared as a field (not a constructor parameter property) so Node can run this file with type stripping in tests.
  readonly code: DeviceErrorCode;
  constructor(message: string, code: DeviceErrorCode = "failed") {
    super(message);
    this.code = code;
  }
}
