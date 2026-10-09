// A polling loop that never overlaps itself: the next run is scheduled only after the previous one settled. The delay
// is asked every time, so it can adapt (fast while the pointer is active, slow when idle) and `null` pauses the loop
// until `wake()` (panel hidden, window not focused).

export type Poller = {
  start(): void;
  stop(): void;
  /** Conditions changed (visible again, pointer active): re-evaluate the delay now. */
  wake(): void;
  readonly inFlight: boolean;
};

export function createPoller(o: {
  run: () => Promise<unknown>;
  /** Milliseconds until the next run, counted from the end of the previous one; null = paused. */
  delay: () => number | null;
  now?: () => number;
}): Poller {
  const now = o.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let inFlight = false;
  let lastEnd = -Infinity;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (stopped || inFlight) return;
    const d = o.delay();
    if (d === null) return; // paused until wake()
    timer = setTimeout(tick, Math.max(0, d - (now() - lastEnd)));
  };
  const tick = async () => {
    timer = undefined;
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await o.run();
    } catch {
      // the caller reports errors; the loop keeps going
    } finally {
      inFlight = false;
      lastEnd = now();
    }
    schedule();
  };
  return {
    start() {
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      clear();
    },
    wake() {
      schedule();
    },
    get inFlight() {
      return inFlight;
    },
  };
}

export type FrameRateInput = { visible: boolean; focused: boolean; sinceActivityMs: number; failing?: boolean };

export const FRAME_INTERVALS = { active: 250, idle: 1500, activeWindowMs: 4000 };

/** ~4 fps while the pointer was active in the last few seconds, ~0.7 fps otherwise, paused when nobody looks. */
export function frameDelay(
  i: FrameRateInput,
  r: { active: number; idle: number; activeWindowMs: number } = FRAME_INTERVALS,
): number | null {
  if (!i.visible || !i.focused) return null;
  const base = i.sinceActivityMs < r.activeWindowMs ? r.active : r.idle;
  return i.failing ? Math.max(base, r.idle) * 2 : base;
}
