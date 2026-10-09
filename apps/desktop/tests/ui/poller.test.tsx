import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPoller } from "../../src/components/device/poller";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);

it("runs again only after the previous run settled, however slow it is", async () => {
  let running = 0;
  let peak = 0;
  let runs = 0;
  const poller = createPoller({
    run: async () => {
      runs++;
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 500));
      running--;
    },
    delay: () => 100,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(5000);
  poller.stop();
  expect(peak).toBe(1);
  expect(runs).toBeGreaterThan(5);
  expect(runs).toBeLessThan(10); // ~600 ms per cycle
});

it("a null delay pauses the loop until wake()", async () => {
  let paused = true;
  let runs = 0;
  const poller = createPoller({ run: async () => void runs++, delay: () => (paused ? null : 50) });
  poller.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toBe(0);
  paused = false;
  poller.wake();
  await vi.advanceTimersByTimeAsync(60);
  expect(runs).toBeGreaterThan(0);
  paused = true;
  await vi.advanceTimersByTimeAsync(100); // the run already scheduled still fires, then the loop parks
  const parked = runs;
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toBe(parked);
  poller.stop();
});

it("wake() shortens a long wait when the pointer becomes active", async () => {
  let delay = 5000;
  let runs = 0;
  const poller = createPoller({ run: async () => void runs++, delay: () => delay });
  poller.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(runs).toBe(1); // the first run is immediate
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toBe(1); // the next one waits 5 s
  delay = 200;
  poller.wake();
  await vi.advanceTimersByTimeAsync(1);
  expect(runs).toBe(2); // 200 ms have long passed since the last run ended, so it runs now
  poller.stop();
});

it("keeps going after a failed run, and stop() ends it", async () => {
  let runs = 0;
  const poller = createPoller({
    run: async () => {
      runs++;
      throw new Error("boom");
    },
    delay: () => 10,
  });
  poller.start();
  await vi.advanceTimersByTimeAsync(100);
  expect(runs).toBeGreaterThan(3);
  poller.stop();
  await settle();
  const stopped = runs;
  await vi.advanceTimersByTimeAsync(500);
  expect(runs).toBe(stopped);
});
