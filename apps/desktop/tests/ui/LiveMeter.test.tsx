import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveMeter } from "../../src/components/LiveMeter";
import { renderApp } from "./render";

const START = 1_700_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const meter = () => document.querySelector(".live-meter")!.textContent;

describe("LiveMeter", () => {
  it("counts in readable units: 59 s, then 1 min 0 s, then hours without seconds", () => {
    renderApp(<LiveMeter stats={{ start: START, chars: 300, input: 25_397 }} />);
    expect(meter()).toBe("↑ ≈25,397 · ↓ ≈100 tokens · 0 s");
    advance(59_000);
    expect(meter()).toContain("· 59 s");
    advance(1_000);
    expect(meter()).toContain("· 1 min 0 s");
    advance(162_000);
    expect(meter()).toContain("· 3 min 42 s");
    advance(5_400_000 - 222_000);
    expect(meter()).toContain("· 1 h 30 min");
    expect(meter()).not.toMatch(/\d+ s\b/);
  });

  it("uses Russian units in the Russian locale", () => {
    renderApp(<LiveMeter stats={{ start: START, chars: 0, input: 1 }} />, undefined, "ru");
    advance(59_000);
    expect(screen.getByTitle(/Оценка по длине текста/).textContent).toContain("· 59 с");
    advance(1_000);
    expect(meter()).toContain("· 1 мин 0 с");
  });
});
