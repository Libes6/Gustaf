import { expect, it, vi } from "vite-plus/test";
import { createWallpaperWatchdog } from "./wallpaperWatchdog";

it("expires once after missing frames, resets on frames and cancels on pause or disposal", () => {
  vi.useFakeTimers();
  try {
    const stalled = vi.fn();
    const watchdog = createWallpaperWatchdog(stalled);
    watchdog.frame();
    vi.advanceTimersByTime(1000);
    expect(stalled).not.toHaveBeenCalled();
    watchdog.start();
    vi.advanceTimersByTime(900);
    watchdog.frame();
    vi.advanceTimersByTime(900);
    expect(stalled).not.toHaveBeenCalled();
    watchdog.stop();
    vi.advanceTimersByTime(1000);
    expect(stalled).not.toHaveBeenCalled();
    watchdog.start();
    vi.advanceTimersByTime(900);
    watchdog.start();
    vi.advanceTimersByTime(100);
    expect(stalled).toHaveBeenCalledTimes(1);
    watchdog.frame();
    vi.advanceTimersByTime(1000);
    expect(stalled).toHaveBeenCalledTimes(1);
    watchdog.start();
    watchdog.stop();
    vi.advanceTimersByTime(1000);
    expect(stalled).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
