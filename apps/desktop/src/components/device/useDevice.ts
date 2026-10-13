// State and effects of the Device panel: toolchain, device list, the selected device, the live frame loop, the
// interface map and a serial queue for actions (so no click is dropped while another action is still running).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeviceError,
  type ActionResult,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceToolchain,
  type Frame,
} from "../../device/types";
import type { UiMap } from "../../device/uiMap";
import { createDebouncer, createPoller, frameDelay, FRAME_INTERVALS, type FrameIntervals, type Poller } from "./poller";

export type DeviceErrorState = { message: string; code?: DeviceError["code"]; source: "frame" | "action" | "other" };

export type UseDeviceOptions = {
  /** The panel is on screen (its tab is selected). */
  visible: boolean;
  intervals?: FrameIntervals;
  /** The interface map is on screen (its pane is open or Inspect mode is on). Default true. Off: no map refreshes. */
  mapOpen?: boolean;
  /** Wait after the last input before the map is read again. Default 400 ms. */
  mapDebounceMs?: number;
};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toError = (e: unknown, source: DeviceErrorState["source"]): DeviceErrorState => ({
  message: messageOf(e),
  code: e instanceof DeviceError ? e.code : undefined,
  source,
});

export function useDevice(driver: DeviceDriver | null, opts: UseDeviceOptions) {
  const [toolchain, setToolchain] = useState<DeviceToolchain | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [map, setMap] = useState<UiMap | null>(null);
  const [mapLoading, setMapLoading] = useState(false);
  const [error, setError] = useState<DeviceErrorState | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [powering, setPowering] = useState<Record<string, "boot" | "shutdown">>({});
  const [install, setInstall] = useState<{ running: boolean; lines: string[]; error?: string }>({
    running: false,
    lines: [],
  });
  const [focused, setFocused] = useState(true);
  const [windowVisible, setWindowVisible] = useState(true);

  const intervals = opts.intervals ?? FRAME_INTERVALS;
  const mapOpen = opts.mapOpen ?? true;
  const mapDebounceMs = opts.mapDebounceMs ?? 400;
  const mapOpenRef = useRef(mapOpen);
  mapOpenRef.current = mapOpen;
  const live = useRef({ visible: opts.visible, focused: true, windowVisible: true, failing: false, activity: 0 });
  const poller = useRef<Poller | null>(null);
  const selectedRef = useRef<string | null>(null);
  const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ---- focus / visibility of the window ----
  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    const onVis = () => setWindowVisible(document.visibilityState !== "hidden");
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  useEffect(() => {
    live.current.visible = opts.visible;
    live.current.focused = focused;
    live.current.windowVisible = windowVisible;
    poller.current?.wake();
  }, [opts.visible, focused, windowVisible]);

  /** The pointer moved or clicked on the screen: poll faster for a few seconds. */
  const noteActivity = useCallback(() => {
    live.current.activity = Date.now();
    poller.current?.wake();
  }, []);

  // ---- toolchain and device list ----
  const refresh = useCallback(async () => {
    if (!driver) return;
    setLoading(true);
    const [tc, list] = await Promise.allSettled([driver.toolchain(), driver.list()]);
    if (!mounted.current) return;
    setLoading(false);
    if (tc.status === "fulfilled") setToolchain(tc.value);
    if (list.status === "fulfilled") setDevices(list.value);
    else setDevices((d) => d ?? []);
    const failed = tc.status === "rejected" ? tc.reason : list.status === "rejected" ? list.reason : null;
    setError(failed ? toError(failed, "other") : null);
  }, [driver]);
  useEffect(() => {
    setToolchain(null);
    setDevices(null);
    setSelectedId(null);
    setFrame(null);
    setMap(null);
    void refresh();
  }, [refresh]);

  const selected = useMemo(() => devices?.find((d) => d.id === selectedId) ?? null, [devices, selectedId]);
  const booted = selected?.state === "booted";
  const helperReady = toolchain?.helper.installed === true;
  const helperReadyRef = useRef(helperReady);
  helperReadyRef.current = helperReady;
  selectedRef.current = selectedId;

  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedId(id);
    setFrame(null);
    setMap(null);
    setError(null);
    live.current.failing = false;
  }, []);

  // ---- the interface map ----
  const loadMap = useCallback(
    async (background: boolean) => {
      const id = selectedRef.current;
      if (!driver || !id) return;
      setMapLoading(true);
      try {
        const next = await driver.snapshot(id, background ? { background: true } : undefined);
        if (mounted.current && selectedRef.current === id) setMap(next);
      } catch (e) {
        if (mounted.current && selectedRef.current === id) setError(toError(e, "other"));
      } finally {
        if (mounted.current) setMapLoading(false);
      }
    },
    [driver],
  );
  const refreshMap = useCallback(() => loadMap(false), [loadMap]);
  useEffect(() => {
    if (booted && helperReady && selectedId && mapOpen) void refreshMap();
  }, [booted, helperReady, selectedId, mapOpen, refreshMap]);

  // After input the map is read once, a moment after the LAST action (a burst of taps costs one snapshot), and only
  // while somebody can see it. It is a background snapshot: the next action overtakes it.
  const mapDebouncer = useRef<ReturnType<typeof createDebouncer> | null>(null);
  useEffect(() => {
    const d = createDebouncer(() => {
      if (mounted.current && mapOpenRef.current && helperReadyRef.current && pending.current === 0) void loadMap(true);
    }, mapDebounceMs);
    mapDebouncer.current = d;
    return () => {
      d.cancel();
      if (mapDebouncer.current === d) mapDebouncer.current = null;
    };
  }, [loadMap, mapDebounceMs]);

  // ---- the frame loop ----
  const grabFrame = useCallback(async () => {
    const id = selectedRef.current;
    if (!driver || !id) return;
    try {
      const f = await driver.frame(id);
      if (!mounted.current || selectedRef.current !== id) return;
      live.current.failing = false;
      setFrame(f);
      setError((e) => (e?.source === "frame" ? null : e));
    } catch (e) {
      if (!mounted.current || selectedRef.current !== id) return;
      live.current.failing = true;
      setError(toError(e, "frame"));
    }
  }, [driver]);
  useEffect(() => {
    if (!driver || !selectedId || !booted) return;
    const p = createPoller({
      // Frames never wait for actions (they only call simctl/adb), so the picture keeps moving while one runs.
      run: () => grabFrame(),
      delay: () =>
        frameDelay(
          {
            visible: live.current.visible && live.current.windowVisible,
            focused: live.current.focused,
            sinceActivityMs: Date.now() - live.current.activity,
            failing: live.current.failing,
          },
          intervals,
        ),
    });
    poller.current = p;
    p.start();
    return () => {
      p.stop();
      if (poller.current === p) poller.current = null;
    };
  }, [driver, selectedId, booted, grabFrame, intervals]);

  // ---- actions: strictly one after another ----
  // Input goes through the driver's fast `human` calls when it has them (no settle, no snapshot afterwards). The chain
  // waits only for the action itself: the new picture and the map are requested afterwards, without blocking the next
  // click, and the frame loop switches to its burst rate.
  const run = useCallback(
    (label: string, fn: (d: DeviceDriver, id: string) => Promise<ActionResult | void>) => {
      const id = selectedRef.current;
      if (!driver || !id) return Promise.resolve(null);
      pending.current++;
      setQueue((q) => [...q, label]);
      const target: DeviceDriver = driver.human
        ? Object.assign(Object.create(driver) as DeviceDriver, driver.human)
        : driver;
      const job = chain.current.then(async (): Promise<ActionResult | null> => {
        let result: ActionResult | null = null;
        try {
          result = (await fn(target, id)) ?? null;
          if (mounted.current) setError((e) => (e?.source === "action" ? null : e));
        } catch (e) {
          if (mounted.current) setError(toError(e, "action"));
        }
        if (mounted.current && selectedRef.current === id) {
          live.current.activity = Date.now();
          poller.current?.wake();
          if (helperReady) mapDebouncer.current?.trigger();
        }
        return result;
      });
      chain.current = job.finally(() => {
        pending.current--;
        if (mounted.current) setQueue((q) => q.slice(1));
      });
      return job;
    },
    [driver, helperReady],
  );

  // ---- power ----
  const boot = useCallback(
    async (id: string) => {
      if (!driver) return;
      setPowering((p) => ({ ...p, [id]: "boot" }));
      setError(null);
      try {
        await driver.boot(id);
        await refresh();
        if (mounted.current) select(id);
      } catch (e) {
        if (mounted.current) setError(toError(e, "other"));
      } finally {
        if (mounted.current)
          setPowering((p) => {
            const { [id]: _gone, ...rest } = p;
            return rest;
          });
      }
    },
    [driver, refresh, select],
  );
  const shutdown = useCallback(
    async (id: string) => {
      if (!driver) return;
      setPowering((p) => ({ ...p, [id]: "shutdown" }));
      try {
        await driver.shutdown(id);
        if (mounted.current && selectedRef.current === id) select(null);
        await refresh();
      } catch (e) {
        if (mounted.current) setError(toError(e, "other"));
      } finally {
        if (mounted.current)
          setPowering((p) => {
            const { [id]: _gone, ...rest } = p;
            return rest;
          });
      }
    },
    [driver, refresh, select],
  );

  // ---- the helper: installed only when this is called (the panel calls it from a button) ----
  const installHelper = useCallback(async () => {
    if (!driver) return;
    setInstall({ running: true, lines: [] });
    try {
      await driver.installHelper((line) => {
        if (mounted.current) setInstall((s) => ({ ...s, lines: [...s.lines, line] }));
      });
      if (mounted.current) setInstall((s) => ({ ...s, running: false }));
      await refresh();
    } catch (e) {
      if (mounted.current) setInstall((s) => ({ ...s, running: false, error: messageOf(e) }));
    }
  }, [driver, refresh]);

  return {
    toolchain,
    devices,
    loading,
    selectedId,
    selected,
    booted,
    helperReady,
    frame,
    map,
    mapLoading,
    error,
    clearError: useCallback(() => setError(null), []),
    /** Labels of the actions waiting or running; the first one is in flight. */
    queue,
    powering,
    install,
    refresh,
    refreshMap,
    select,
    boot,
    shutdown,
    installHelper,
    run,
    noteActivity,
  };
}
