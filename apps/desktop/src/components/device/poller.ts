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

export type FrameRateInput = {
  visible: boolean;
  focused: boolean;
  sinceActivityMs: number;
  failing?: boolean;
  /** The driver pushes frames and `frame()` waits for the next one: ask again at once, whatever the activity. */
  streaming?: boolean;
};

export type FrameIntervals = {
  /** Gap between frames right after input: 0 = the next capture starts as the previous one ends. */
  burst?: number;
  /** How long after the last input the burst rate lasts. */
  burstWindowMs?: number;
  active: number;
  idle: number;
  activeWindowMs: number;
};

export const FRAME_INTERVALS: Required<FrameIntervals> = {
  burst: 0,
  burstWindowMs: 2000,
  active: 150,
  idle: 1500,
  activeWindowMs: 4000,
};

/**
 * Frames as fast as capture allows for a couple of seconds after input (the screen is changing and a person is
 * watching it), a steady rate while the pointer stays active, about 0.7 fps when idle, nothing when nobody looks.
 * Capture never overlaps itself (the Poller), so a slow frame only lowers the rate and never queues.
 */
export function frameDelay(i: FrameRateInput, r: FrameIntervals = FRAME_INTERVALS): number | null {
  if (!i.visible || !i.focused) return null;
  if (i.streaming) return i.failing ? r.idle * 2 : 0;
  const burst = r.burst !== undefined && r.burstWindowMs !== undefined && i.sinceActivityMs < r.burstWindowMs;
  const base = burst ? (r.burst as number) : i.sinceActivityMs < r.activeWindowMs ? r.active : r.idle;
  return i.failing ? Math.max(base, r.idle) * 2 : base;
}

/**
 * Runs `fn` once, `ms` after the LAST `trigger()` (each trigger restarts the wait); `cancel()` drops a pending run.
 * Used for the interface-map refresh: a burst of taps costs one snapshot, taken when the person stopped.
 */
export function createDebouncer(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    trigger() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    get pending() {
      return timer !== undefined;
    },
  };
}
