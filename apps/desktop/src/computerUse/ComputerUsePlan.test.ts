import type { ComputerUseCaptureGeometry, ComputerUseDisplay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  TEXT_CHUNK_UNITS,
  captureIsCurrent,
  captureSize,
  keyCode,
  pressKeys,
  toGlobal,
  typeText,
} from "./ComputerUsePlan.ts";

const display = (
  id: number,
  x: number,
  y: number,
  width: number,
  height: number,
  scale: number,
): ComputerUseDisplay => ({
  id,
  name: `Display ${id}`,
  main: id === 1,
  bounds: { x, y, width, height },
  scale,
});

const captureOf = (target: ComputerUseDisplay): ComputerUseCaptureGeometry => ({
  captureId: "c1",
  displayId: target.id,
  bounds: target.bounds,
  scale: target.scale,
  ...captureSize(target, undefined, undefined),
});

const codeOf = (error: unknown) => (error as { readonly code?: string }).code;
const thrownCode = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return codeOf(error);
  }
  return undefined;
};

describe("computer-use plan", () => {
  it("maps screenshot pixels to global display points", () => {
    // (display, screenshot size, pixel, expected global point)
    const cases = [
      // Retina laptop: 2880x1800 pixels shrink to 1280x800; scale cancels out.
      [display(1, 0, 0, 1440, 900, 2), [1280, 800], [640, 400], [720.5625, 450.5625]],
      // A second display left of and above the main one.
      [display(2, -1920, -200, 1920, 1080, 1), [1280, 720], [0, 0], [-1919.25, -199.25]],
      // A small display is not upscaled: one pixel per point.
      [display(3, 1440, 0, 1024, 768, 1), [1024, 768], [1023, 767], [2463.5, 767.5]],
    ] as const;
    for (const [target, [width, height], [x, y], [globalX, globalY]] of cases) {
      const capture = captureOf(target);
      expect([capture.width, capture.height]).toEqual([width, height]);
      expect(toGlobal(capture, x, y)).toEqual({ x: globalX, y: globalY });
    }
  });

  it("refuses points outside the screenshot or after its display changed", () => {
    const main = display(1, 0, 0, 1440, 900, 2);
    const capture = captureOf(main);
    for (const [x, y] of [
      [1280, 0],
      [0, 800],
      [-1, 5],
      [Number.NaN, 1],
    ] as const) {
      expect(thrownCode(() => toGlobal(capture, x, y))).toBe("out-of-bounds");
    }
    expect(captureIsCurrent(capture, [main])).toBe(true);
    expect(captureIsCurrent(capture, [display(1, 0, 0, 1728, 1117, 2)])).toBe(false);
    expect(captureIsCurrent(capture, [display(1, 0, -900, 1440, 900, 2)])).toBe(false);
    expect(captureIsCurrent(capture, [])).toBe(false);
  });

  it("clamps capture limits", () => {
    const retina = display(1, 0, 0, 1512, 982, 2);
    expect(captureSize(retina, 10, 10)).toEqual({ width: 200, height: 130 });
    expect(captureSize(retina, 99_999, 99_999)).toEqual({ width: 2560, height: 1663 });
  });

  it("types Russian and multi-line text as Unicode chunks", () => {
    const inputs = typeText("Привет, мир! Это проверка ввода 👋\nвторая");
    expect(inputs).toEqual([
      { kind: "text", text: "Привет, мир! Это про" },
      { kind: "text", text: "верка ввода 👋" },
      { kind: "key", code: 0x24, down: true, flags: 0 },
      { kind: "key", code: 0x24, down: false, flags: 0 },
      { kind: "text", text: "вторая" },
    ]);
    for (const input of inputs) {
      if (input.kind === "text") expect(input.text.length).toBeLessThanOrEqual(TEXT_CHUNK_UNITS);
    }
    expect(thrownCode(() => typeText(""))).toBe("invalid-action");
  });

  it("holds modifiers around one key", () => {
    const COMMAND = 0x10_0000;
    const SHIFT = 0x2_0000;
    expect(pressKeys(["Cmd", "shift", "s"], 1)).toEqual([
      { kind: "key", code: 0x37, down: true, flags: COMMAND },
      { kind: "key", code: 0x38, down: true, flags: COMMAND | SHIFT },
      { kind: "key", code: 0x01, down: true, flags: COMMAND | SHIFT },
      { kind: "key", code: 0x01, down: false, flags: COMMAND | SHIFT },
      { kind: "key", code: 0x38, down: false, flags: COMMAND },
      { kind: "key", code: 0x37, down: false, flags: 0 },
    ]);
    expect(pressKeys(["tab"], 3)).toHaveLength(6);
    for (const [names, repeat] of [
      [["command"], 1],
      [["a", "b"], 1],
      [["hyper", "a"], 1],
      [["a"], 0],
      [["a"], 51],
    ] as const) {
      expect(thrownCode(() => pressKeys(names, repeat))).toBe("invalid-action");
    }
  });

  it("names keys of the ANSI layout", () => {
    for (const [name, code] of [
      ["a", 0x00],
      ["s", 0x01],
      ["t", 0x11],
      ["o", 0x1f],
      ["m", 0x2e],
      ["1", 0x12],
      ["0", 0x1d],
      ["Return", 0x24],
      ["esc", 0x35],
      ["up", 0x7e],
      ["/", 0x2c],
    ] as const) {
      expect(keyCode(name), name).toEqual({ code });
    }
    for (const name of ["\0", "я", "constructor"]) expect(keyCode(name)).toBeUndefined();
  });
});
