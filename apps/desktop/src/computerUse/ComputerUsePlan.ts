/**
 * Pure translation of an agent's action into the OS events the helper posts. Points arrive in
 * pixels of a screenshot; events need global display points.
 */
import {
  ComputerUseError,
  type ComputerUseAction,
  type ComputerUseButton,
  type ComputerUseCaptureGeometry,
  type ComputerUseDisplay,
  type ComputerUseImagePoint,
} from "@t3tools/contracts";

/**
 * One OS event, sent to the helper as is. Coordinates are global display points: origin at the
 * top left of the main display, y down, negative to the left of or above it.
 */
export type ComputerUseInput =
  | {
      readonly kind: "move";
      readonly x: number;
      readonly y: number;
      readonly dragging?: ComputerUseButton;
    }
  | {
      readonly kind: "button";
      readonly x: number;
      readonly y: number;
      readonly button: ComputerUseButton;
      readonly down: boolean;
      readonly clicks: number;
    }
  /** At the pointer, which the preceding move placed. */
  | { readonly kind: "scroll"; readonly dx: number; readonly dy: number }
  | { readonly kind: "key"; readonly code: number; readonly down: boolean; readonly flags: number }
  /** At most `TEXT_CHUNK_UNITS` UTF-16 units, the most one event carries. */
  | { readonly kind: "text"; readonly text: string };

const MAX_TEXT_CHARS = 4_000;
export const TEXT_CHUNK_UNITS = 20;
const MAX_SCROLL_LINES = 100;
const MAX_REPEAT = 50;
const MAX_CLICKS = 3;
const DRAG_STEPS = 8;
const DEFAULT_CAPTURE_EDGE = 1280;
const MIN_CAPTURE_EDGE = 200;
const MAX_CAPTURE_EDGE = 2560;
const RETURN = 0x24;

const invalid = (message: string) => new ComputerUseError({ code: "invalid-action", message });

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Pixel size of a screenshot of `display` that fits the limits and is never upscaled. */
export function captureSize(
  display: ComputerUseDisplay,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
): { readonly width: number; readonly height: number } {
  const limit = (value: number | undefined) =>
    clamp(value ?? DEFAULT_CAPTURE_EDGE, MIN_CAPTURE_EDGE, MAX_CAPTURE_EDGE);
  const pixelsWide = display.bounds.width * display.scale;
  const pixelsHigh = display.bounds.height * display.scale;
  const factor = Math.min(limit(maxWidth) / pixelsWide, limit(maxHeight) / pixelsHigh, 1);
  const size = (pixels: number) => Math.max(Math.round(pixels * factor), 1);
  return { width: size(pixelsWide), height: size(pixelsHigh) };
}

/** The global point at the centre of a screenshot pixel. */
export function toGlobal(
  capture: ComputerUseCaptureGeometry,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } {
  const inside = (value: number, size: number) =>
    Number.isFinite(value) && value >= 0 && value < size;
  if (!inside(x, capture.width) || !inside(y, capture.height)) {
    throw new ComputerUseError({
      code: "out-of-bounds",
      message: `(${x}, ${y}) is outside the ${capture.width}x${capture.height} screenshot.`,
    });
  }
  const { bounds } = capture;
  return {
    x: bounds.x + ((x + 0.5) * bounds.width) / capture.width,
    y: bounds.y + ((y + 0.5) * bounds.height) / capture.height,
  };
}

/** A screenshot still describes the screen while its display has the same place and scale. */
export function captureIsCurrent(
  capture: ComputerUseCaptureGeometry,
  displays: readonly ComputerUseDisplay[],
): boolean {
  return displays.some(
    (display) =>
      display.id === capture.displayId &&
      display.bounds.x === capture.bounds.x &&
      display.bounds.y === capture.bounds.y &&
      display.bounds.width === capture.bounds.width &&
      display.bounds.height === capture.bounds.height &&
      display.scale === capture.scale,
  );
}

export function actionPoints(action: ComputerUseAction): readonly ComputerUseImagePoint[] {
  switch (action.type) {
    case "move":
    case "click":
    case "scroll":
      return [action.at];
    case "drag":
      return [action.from, action.to];
    default:
      return [];
  }
}

/**
 * The events for `action`; `resolve` maps a screenshot point to a global one and may throw a
 * `ComputerUseError`, as this does. Activation is not an input and plans nothing.
 */
export function planInputs(
  action: ComputerUseAction,
  resolve: (point: ComputerUseImagePoint) => { readonly x: number; readonly y: number },
): ComputerUseInput[] {
  switch (action.type) {
    case "move":
      return [{ kind: "move", ...resolve(action.at) }];
    case "click": {
      const count = action.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > MAX_CLICKS) {
        throw invalid(`count must be 1 to ${MAX_CLICKS}.`);
      }
      const button = action.button ?? "left";
      const at = resolve(action.at);
      const inputs: ComputerUseInput[] = [{ kind: "move", ...at }];
      for (let clicks = 1; clicks <= count; clicks++) {
        for (const down of [true, false]) {
          inputs.push({ kind: "button", ...at, button, down, clicks });
        }
      }
      return inputs;
    }
    case "drag": {
      const button = action.button ?? "left";
      const from = resolve(action.from);
      const to = resolve(action.to);
      const inputs: ComputerUseInput[] = [
        { kind: "move", ...from },
        { kind: "button", ...from, button, down: true, clicks: 1 },
      ];
      for (let step = 1; step <= DRAG_STEPS; step++) {
        const part = step / DRAG_STEPS;
        inputs.push({
          kind: "move",
          x: from.x + (to.x - from.x) * part,
          y: from.y + (to.y - from.y) * part,
          dragging: button,
        });
      }
      inputs.push({ kind: "button", ...to, button, down: false, clicks: 1 });
      return inputs;
    }
    case "scroll": {
      const dx = action.deltaX ?? 0;
      const dy = action.deltaY ?? 0;
      if (
        [dx, dy].some((delta) => !Number.isInteger(delta) || Math.abs(delta) > MAX_SCROLL_LINES)
      ) {
        throw invalid(`Scroll at most ${MAX_SCROLL_LINES} lines at a time.`);
      }
      return [
        { kind: "move", ...resolve(action.at) },
        { kind: "scroll", dx, dy },
      ];
    }
    case "type":
      return typeText(action.text);
    case "key":
      return pressKeys(action.keys, action.repeat ?? 1);
    case "activate":
      return [];
  }
}

const utf16Units = (text: string) => text.length;

/**
 * Unicode text goes in as text, not key codes, so it does not depend on the keyboard layout.
 * A line break is the Return key: many fields ignore a typed newline.
 */
export function typeText(text: string): ComputerUseInput[] {
  const characters = [...text];
  if (characters.length === 0 || characters.length > MAX_TEXT_CHARS) {
    throw invalid(`text must be 1 to ${MAX_TEXT_CHARS} characters.`);
  }
  const inputs: ComputerUseInput[] = [];
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  lines.forEach((line, index) => {
    if (index > 0) inputs.push(...tap(RETURN, 0));
    let chunk = "";
    for (const character of line) {
      if (utf16Units(chunk) + utf16Units(character) > TEXT_CHUNK_UNITS) {
        inputs.push({ kind: "text", text: chunk });
        chunk = "";
      }
      chunk += character;
    }
    if (chunk.length > 0) inputs.push({ kind: "text", text: chunk });
  });
  return inputs;
}

const tap = (code: number, flags: number): ComputerUseInput[] => [
  { kind: "key", code, down: true, flags },
  { kind: "key", code, down: false, flags },
];

/** Modifiers go down in the order given, the key is pressed, then modifiers come up in reverse. */
export function pressKeys(keys: readonly string[], repeat: number): ComputerUseInput[] {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    throw invalid(`repeat must be 1 to ${MAX_REPEAT}.`);
  }
  const modifiers: Array<{ readonly code: number; readonly flag: number }> = [];
  let key: number | undefined;
  for (const name of keys) {
    const found = keyCode(name);
    if (found === undefined) throw invalid(`Unknown key "${name}".`);
    if (found.modifier !== undefined) {
      if (!modifiers.some((modifier) => modifier.code === found.code)) {
        modifiers.push({ code: found.code, flag: found.modifier });
      }
    } else if (key === undefined) {
      key = found.code;
    } else {
      throw invalid('Press one key at a time, with any modifiers, such as ["command", "s"].');
    }
  }
  if (key === undefined) {
    throw invalid('Name one key besides the modifiers, such as ["command", "s"].');
  }
  const inputs: ComputerUseInput[] = [];
  for (let round = 0; round < repeat; round++) {
    let flags = 0;
    for (const modifier of modifiers) {
      flags |= modifier.flag;
      inputs.push({ kind: "key", code: modifier.code, down: true, flags });
    }
    inputs.push(...tap(key, flags));
    for (const modifier of modifiers.toReversed()) {
      flags &= ~modifier.flag;
      inputs.push({ kind: "key", code: modifier.code, down: false, flags });
    }
  }
  return inputs;
}

const SHIFT = 0x0002_0000;
const CONTROL = 0x0004_0000;
const OPTION = 0x0008_0000;
const COMMAND = 0x0010_0000;
const FUNCTION = 0x0080_0000;

const MODIFIERS: Readonly<Record<string, readonly [code: number, flag: number]>> = {
  command: [0x37, COMMAND],
  cmd: [0x37, COMMAND],
  meta: [0x37, COMMAND],
  super: [0x37, COMMAND],
  shift: [0x38, SHIFT],
  option: [0x3a, OPTION],
  opt: [0x3a, OPTION],
  alt: [0x3a, OPTION],
  control: [0x3b, CONTROL],
  ctrl: [0x3b, CONTROL],
  fn: [0x3f, FUNCTION],
  function: [0x3f, FUNCTION],
};

/** macOS virtual key codes of the ANSI layout, by key name. */
const KEYS: Readonly<Record<string, number>> = {
  return: RETURN,
  enter: RETURN,
  tab: 0x30,
  space: 0x31,
  backspace: 0x33,
  delete: 0x33,
  escape: 0x35,
  esc: 0x35,
  forwarddelete: 0x75,
  del: 0x75,
  home: 0x73,
  end: 0x77,
  pageup: 0x74,
  pagedown: 0x79,
  left: 0x7b,
  arrowleft: 0x7b,
  right: 0x7c,
  arrowright: 0x7c,
  down: 0x7d,
  arrowdown: 0x7d,
  up: 0x7e,
  arrowup: 0x7e,
  f1: 0x7a,
  f2: 0x78,
  f3: 0x63,
  f4: 0x76,
  f5: 0x60,
  f6: 0x61,
  f7: 0x62,
  f8: 0x64,
  f9: 0x65,
  f10: 0x6d,
  f11: 0x67,
  f12: 0x6f,
  a: 0x00,
  s: 0x01,
  d: 0x02,
  f: 0x03,
  h: 0x04,
  g: 0x05,
  z: 0x06,
  x: 0x07,
  c: 0x08,
  v: 0x09,
  b: 0x0b,
  q: 0x0c,
  w: 0x0d,
  e: 0x0e,
  r: 0x0f,
  y: 0x10,
  t: 0x11,
  o: 0x1f,
  u: 0x20,
  i: 0x22,
  p: 0x23,
  l: 0x25,
  j: 0x26,
  k: 0x28,
  n: 0x2d,
  m: 0x2e,
  "1": 0x12,
  "2": 0x13,
  "3": 0x14,
  "4": 0x15,
  "6": 0x16,
  "5": 0x17,
  "=": 0x18,
  "9": 0x19,
  "7": 0x1a,
  "-": 0x1b,
  "8": 0x1c,
  "0": 0x1d,
  "]": 0x1e,
  "[": 0x21,
  "'": 0x27,
  ";": 0x29,
  "\\": 0x2a,
  ",": 0x2b,
  "/": 0x2c,
  ".": 0x2f,
  "`": 0x32,
};

/**
 * Letters name keys, not characters: with a Russian layout, ["command", "s"] is still Save.
 * Own properties only, so "constructor" is no key.
 */
export function keyCode(
  name: string,
): { readonly code: number; readonly modifier?: number } | undefined {
  const normalized = name.trim().toLowerCase();
  if (Object.hasOwn(MODIFIERS, normalized)) {
    const [code, modifier] = MODIFIERS[normalized]!;
    return { code, modifier };
  }
  return Object.hasOwn(KEYS, normalized) ? { code: KEYS[normalized]! } : undefined;
}
