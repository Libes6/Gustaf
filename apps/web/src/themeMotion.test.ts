import { describe, expect, it } from "vite-plus/test";

import { themeMotionPaused } from "./themeMotion";

describe("themeMotionPaused", () => {
  const active = { visible: true, focused: true, idleMs: 0 };

  it("runs while the window is visible, focused, and in use", () => {
    expect(themeMotionPaused(active)).toBe(false);
    expect(themeMotionPaused({ ...active, idleMs: 29_999 })).toBe(false);
  });

  it("pauses when the window is hidden, unfocused, or left alone", () => {
    expect(themeMotionPaused({ ...active, visible: false })).toBe(true);
    expect(themeMotionPaused({ ...active, focused: false })).toBe(true);
    expect(themeMotionPaused({ ...active, idleMs: 30_000 })).toBe(true);
  });
});
