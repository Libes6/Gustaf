import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_USAGE_LIMITS_DISPLAY,
  displayedPercent,
  paceDisplayPercent,
  windowDisplayPercent,
} from "./usageLimitsDisplay.ts";

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-24T12:00:00Z"));
const window = (overrides: Partial<ServerProviderUsageWindow> = {}): ServerProviderUsageWindow => ({
  id: "w",
  label: "5-hour",
  kind: "session",
  usedPercent: 60,
  ...overrides,
});

describe("usage limits display", () => {
  it("defaults to showing what is used, as limit widgets did before the setting", () => {
    expect(DEFAULT_USAGE_LIMITS_DISPLAY).toBe("used");
  });

  it("shows 60% spent as 60% used or 40% remaining", () => {
    expect(windowDisplayPercent(window(), "used")).toBe(60);
    expect(windowDisplayPercent(window(), "remaining")).toBe(40);
  });

  it("keeps used and remaining adding to 100, including at rounding halves and out of range", () => {
    for (const usedPercent of [0, 12.5, 33.33, 99.5, 100, 140, -5]) {
      const used = windowDisplayPercent(window({ usedPercent }), "used");
      const remaining = windowDisplayPercent(window({ usedPercent }), "remaining");
      expect(used + remaining).toBe(100);
      expect(used).toBeGreaterThanOrEqual(0);
      expect(remaining).toBeLessThanOrEqual(100);
    }
  });

  it("converts pooled remaining shares", () => {
    expect(displayedPercent(25, "used")).toBe(75);
    expect(displayedPercent(25, "remaining")).toBe(25);
  });

  it("puts even pace where the mode's bar fill ends up", () => {
    // 5 hours long, 3 hours left: 40% elapsed, 60% of the window left.
    const timed = window({
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(NOW + 3 * 60 * 60_000)),
      windowDurationMins: 300,
    });
    expect(paceDisplayPercent(timed, NOW, "used")).toBe(40);
    expect(paceDisplayPercent(timed, NOW, "remaining")).toBe(60);
    expect(paceDisplayPercent(window(), NOW, "used")).toBeNull();
    expect(paceDisplayPercent(window(), NOW, "remaining")).toBeNull();
  });
});
