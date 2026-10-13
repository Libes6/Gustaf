// A client for the native simulator helper (native/gustaf-sim.m): touch, buttons and a pushed frame stream for ONE iOS
// Simulator over JSON lines. The transport is injected (hostProcess.ts starts the real process through
// providers/processHost.ts), so framing, acknowledgements, crashes and the "unavailable" paths are tested with fakes.
//
// The helper talks to Xcode's private CoreSimulator / SimulatorKit frameworks, so every failure mode ends the same
// way: `open()` resolves `undefined` (never throws) and the driver keeps using simctl screenshots and the
// agent-device helper. A session that crashes is restarted a few times, then given up on for that device.

import type { HostTransport } from "./helperHost";

export type NativeFrame = {
  seq: number;
  /** JPEG, base64. */
  data: string;
  /** The encoded image. */
  width: number;
  height: number;
  /** The simulator's full framebuffer in pixels (what points are derived from). */
  pixelWidth: number;
  pixelHeight: number;
};

export type TouchPhase = "down" | "move" | "up";
export type ScreenPoints = { sw: number; sh: number };

export type NativeSession = {
  readonly alive: boolean;
  /** The framebuffer size in pixels. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** Fire and forget; requests reach the helper in call order. */
  touch(phase: TouchPhase, x: number, y: number, s: ScreenPoints): void;
  /** Down, hold, up; resolves when the helper finished it. */
  tap(x: number, y: number, s: ScreenPoints, holdMs?: number): Promise<void>;
  swipe(from: { x: number; y: number }, to: { x: number; y: number }, ms: number, s: ScreenPoints): Promise<void>;
  button(name: "home" | "lock" | "side" | "siri"): Promise<void>;
  /** A hardware key by USB HID usage (layout independent ones only: Enter is 40). */
  key(usage: number): Promise<void>;
  /** Frames pushed when the screen changes, at most `fps` per second. */
  startFrames(o?: { fps?: number; scale?: number; quality?: number }): void;
  /** The next frame with a sequence number above `after`; the latest one after `timeoutMs` (undefined: none yet). */
  nextFrame(after: number, timeoutMs: number): Promise<NativeFrame | undefined>;
  close(): Promise<void>;
};

export type NativeSimOptions = {
  spawn: (udid: string) => Promise<HostTransport>;
  readyTimeoutMs?: number;
  /** Restarts after a crash before the device is given up on. Default 2. */
  maxRestarts?: number;
  /** Why a device cannot use the native helper (logged by the caller; never shown as an error). */
  onUnavailable?: (udid: string, reason: string) => void;
};

export type NativeSim = {
  /** The session for a simulator, started on first use; undefined when the native helper cannot be used. */
  open(udid: string): Promise<NativeSession | undefined>;
  /** The live session, if one is open and healthy: never starts anything. */
  peek(udid: string): NativeSession | undefined;
  close(udid: string): Promise<void>;
  closeAll(): Promise<void>;
};

type Waiter = { after: number; done: (f: NativeFrame | undefined) => void; timer: ReturnType<typeof setTimeout> };

export function createNativeSim(o: NativeSimOptions): NativeSim {
  const sessions = new Map<string, { promise: Promise<SessionImpl | undefined>; impl?: SessionImpl }>();
  const crashes = new Map<string, number>();
  const gaveUp = new Set<string>();
  let closed = false;
  let globallyOff = false;

  class SessionImpl implements NativeSession {
    alive = true;
    pixelWidth = 0;
    pixelHeight = 0;
    private nextId = 1;
    private pending = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
    private latest: NativeFrame | undefined;
    private lastDelivered = 0;
    private waiters: Waiter[] = [];
    readonly udid: string;
    private t: HostTransport;
    constructor(udid: string, t: HostTransport) {
      this.udid = udid;
      this.t = t;
    }

    send(m: Record<string, unknown>) {
      if (!this.alive) return;
      this.t.write(JSON.stringify(m)).catch(() => this.die());
    }
    private request(m: Record<string, unknown>): Promise<void> {
      if (!this.alive) return Promise.reject(new Error("The native helper is not running."));
      const id = this.nextId++;
      return new Promise<void>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.send({ ...m, id });
      });
    }
    die() {
      if (!this.alive) return;
      this.alive = false;
      for (const [id, p] of this.pending) {
        p.reject(new Error("The native helper stopped."));
        this.pending.delete(id);
      }
      for (const w of this.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.done(undefined);
      }
    }
    onMessage(m: Record<string, unknown>) {
      if (m.event === "frame" && typeof m.data === "string") {
        const f: NativeFrame = {
          seq: Number(m.seq),
          data: m.data,
          width: Number(m.w),
          height: Number(m.h),
          pixelWidth: Number(m.pw),
          pixelHeight: Number(m.ph),
        };
        // A frame nobody asked for yet is replaced by the newer one; its slot is given back at once.
        if (this.latest && this.latest.seq > this.lastDelivered) this.send({ op: "ack", seq: this.latest.seq });
        this.latest = f;
        this.pixelWidth = f.pixelWidth;
        this.pixelHeight = f.pixelHeight;
        this.flush();
      } else if (typeof m.id === "number") {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok === false)
          p.reject(new Error(typeof m.error === "string" ? m.error : "The native helper refused the request."));
        else p.resolve();
      }
    }
    private flush() {
      const f = this.latest;
      if (!f) return;
      for (const w of [...this.waiters]) {
        if (f.seq > w.after) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          clearTimeout(w.timer);
          this.deliver(f);
          w.done(f);
        }
      }
    }
    private deliver(f: NativeFrame) {
      if (f.seq > this.lastDelivered) {
        this.lastDelivered = f.seq;
        this.send({ op: "ack", seq: f.seq });
      }
    }

    touch(phase: TouchPhase, x: number, y: number, s: ScreenPoints) {
      this.send({ op: "touch", phase, x, y, sw: s.sw, sh: s.sh });
    }
    tap(x: number, y: number, s: ScreenPoints, holdMs = 40) {
      return this.request({ op: "tap", x, y, sw: s.sw, sh: s.sh, holdMs });
    }
    swipe(from: { x: number; y: number }, to: { x: number; y: number }, ms: number, s: ScreenPoints) {
      return this.request({ op: "swipe", x1: from.x, y1: from.y, x2: to.x, y2: to.y, ms, sw: s.sw, sh: s.sh });
    }
    async button(name: "home" | "lock" | "side" | "siri") {
      await this.request({ op: "button", name, down: true });
      await this.request({ op: "button", name, down: false });
    }
    async key(usage: number) {
      await this.request({ op: "key", usage, down: true });
      await this.request({ op: "key", usage, down: false });
    }
    startFrames(f: { fps?: number; scale?: number; quality?: number } = {}) {
      this.send({ op: "frames", on: true, fps: f.fps ?? 30, scale: f.scale ?? 0.5, quality: f.quality ?? 0.55 });
    }
    nextFrame(after: number, timeoutMs: number) {
      if (!this.alive) return Promise.resolve(undefined);
      if (this.latest && this.latest.seq > after) {
        this.deliver(this.latest);
        return Promise.resolve(this.latest);
      }
      return new Promise<NativeFrame | undefined>((done) => {
        const w: Waiter = {
          after,
          done,
          timer: setTimeout(() => {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            // Nothing changed on screen: hand back the picture we have so the caller knows we are alive.
            if (this.latest) this.deliver(this.latest);
            done(this.latest);
          }, timeoutMs),
        };
        this.waiters.push(w);
      });
    }
    async close() {
      const was = this.alive;
      this.send({ op: "quit" });
      this.die();
      if (was) await this.t.stop().catch(() => undefined);
    }
  }

  async function start(udid: string): Promise<SessionImpl | undefined> {
    let t: HostTransport;
    try {
      t = await o.spawn(udid);
    } catch (e) {
      o.onUnavailable?.(udid, `could not start: ${e instanceof Error ? e.message : String(e)}`);
      globallyOff = true; // no binary (no Xcode tools, compile failed): the same for every device
      return undefined;
    }
    const s = new SessionImpl(udid, t);
    let ready!: (m: { ok?: boolean; reason?: string; pw?: number; ph?: number }) => void;
    const readyP = new Promise<Parameters<typeof ready>[0]>((r) => (ready = r));
    t.onMessage((m) => {
      if (!m || typeof m !== "object") return;
      const msg = m as Record<string, unknown>;
      if (msg.event === "ready") ready(msg as Parameters<typeof ready>[0]);
      else s.onMessage(msg);
    });
    void t.closed.then(() => {
      s.die();
      ready({ ok: false, reason: "the helper exited" });
      const entry = sessions.get(udid);
      if (entry?.impl === s) {
        sessions.delete(udid);
        if (!closed) {
          const n = (crashes.get(udid) ?? 0) + 1;
          crashes.set(udid, n);
          if (n > (o.maxRestarts ?? 2)) gaveUp.add(udid);
        }
      }
    });
    const late = new Promise<{ ok: false; reason: string }>((r) =>
      setTimeout(() => r({ ok: false, reason: "no answer in time" }), o.readyTimeoutMs ?? 10_000),
    );
    const r = await Promise.race([readyP, late]);
    if (!r.ok) {
      o.onUnavailable?.(udid, r.reason ?? "not available");
      // Missing private API symbols or classes affect every device; a missing device only this one.
      if (/missing|SimulatorKit|SimServiceContext/i.test(r.reason ?? "")) globallyOff = true;
      else gaveUp.add(udid);
      void t.stop().catch(() => undefined);
      s.die();
      return undefined;
    }
    s.pixelWidth = r.pw ?? 0;
    s.pixelHeight = r.ph ?? 0;
    return s;
  }

  return {
    async open(udid) {
      if (closed || globallyOff || gaveUp.has(udid)) return undefined;
      let entry = sessions.get(udid);
      if (!entry) {
        const e: { promise: Promise<SessionImpl | undefined>; impl?: SessionImpl } = {
          promise: start(udid).then((s) => {
            if (s) e.impl = s;
            else if (sessions.get(udid) === e) sessions.delete(udid);
            return s;
          }),
        };
        sessions.set(udid, (entry = e));
      }
      const s = await entry.promise;
      return s?.alive ? s : undefined;
    },
    peek(udid) {
      const s = sessions.get(udid)?.impl;
      return s?.alive ? s : undefined;
    },
    async close(udid) {
      const e = sessions.get(udid);
      sessions.delete(udid);
      crashes.delete(udid);
      const s = e ? await e.promise.catch(() => undefined) : undefined;
      await s?.close();
    },
    async closeAll() {
      closed = true;
      await Promise.all([...sessions.keys()].map((id) => this.close(id)));
    },
  };
}
