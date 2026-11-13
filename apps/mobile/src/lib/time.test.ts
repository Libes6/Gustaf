import { describe, expect, it } from "vite-plus/test";
import { msUntilRelativeTimeChange, relativeTime } from "./time";

const at = "2026-10-19T12:00:00.000Z";
const timestamp = Date.parse(at);

describe("relative time", () => {
  it.each([
    [59_999, "<1m", "1m", "<1 мин", "1 мин"],
    [119_999, "1m", "2m", "1 мин", "2 мин"],
    [3_599_999, "59m", "1h", "59 мин", "1 ч"],
    [7_199_999, "1h", "2h", "1 ч", "2 ч"],
    [86_399_999, "23h", "1d", "23 ч", "1 д"],
    [172_799_999, "1d", "2d", "1 д", "2 д"],
  ] as const)(
    "updates at the next boundary after %i ms",
    (elapsed, before, after, ruBefore, ruAfter) => {
      const nowMs = timestamp + elapsed;
      expect(relativeTime(at, nowMs, "en-US")).toBe(before);
      expect(msUntilRelativeTimeChange(at, nowMs)).toBe(1);
      expect(relativeTime(at, nowMs + 1, "en-US")).toBe(after);
      expect(relativeTime(at, nowMs, "ru-RU")).toBe(ruBefore);
      expect(relativeTime(at, nowMs + 1, "ru-RU")).toBe(ruAfter);
    },
  );

  it.each([
    [0, 60_000],
    [60_000, 60_000],
    [3_600_000, 3_600_000],
    [86_400_000, 86_400_000],
  ])("waits a full label interval at %i ms", (elapsed, delay) => {
    expect(msUntilRelativeTimeChange(at, timestamp + elapsed)).toBe(delay);
  });

  it("keeps invalid timestamps static", () => {
    expect(relativeTime("invalid", timestamp, "en-US")).toBe("<1m");
    expect(msUntilRelativeTimeChange("invalid", timestamp)).toBeNull();
  });

  it("waits until a future timestamp is a minute old, with bounded timers", () => {
    expect(relativeTime(at, timestamp - 30_000, "en-US")).toBe("<1m");
    expect(msUntilRelativeTimeChange(at, timestamp - 30_000)).toBe(90_000);
    expect(msUntilRelativeTimeChange(at, timestamp - 30 * 86_400_000)).toBe(86_400_000);
  });
});
