// The real DeviceDriver: iOS simulators through `xcrun simctl`, Android through `adb` / `emulator`, and everything that
// needs the accessibility tree or a gesture through the pinned `agent-device` helper (npm, installed into the app's own
// folder on request, run with node from there: never a global install, never npx at call time).
//
// Every process is started through the injected `run` (runner.ts); the real one goes through providers/processHost.ts.
// Design:
//   * Coordinates: every Target / Rect / Point is in DEVICE POINTS on iOS (the helper's own unit) and in the helper's
//     coordinate unit on Android (pixels). `frame().points` is the screen in that unit, so the panel never converts.
//   * One helper session per device id (`gustaf-<id>`), always with explicit --session / --udid|--serial / --platform,
//     so devices never mix. A helper session is bound to ONE app (SpringBoard when none is open); see `Bound`.
//   * Concurrency: mutating calls and snapshots of one device run one after another (KeyedQueue); `frame` never waits
//     behind them; concurrent snapshots share one run unless an action was queued in between.

import { APP_NAMES_SCRIPT, bundleForLabel, parseLanguages } from "./appNames";
import { imageInfo } from "./image";
import { KeyedQueue } from "./keyed";
import { helperDiffText, mapDiffText } from "./actionText";
import { helperFailure, parseHelperReply, type HelperData } from "./helperOutput";
import { androidDevices, avdName, parseAdbDevices, parseAvdList, parseSimctlList, sortDevices } from "./lists";
import { HostError, type HelperHost } from "./helperHost";
import type { NativeSession, NativeSim } from "./nativeSim";
import type { CommandRunner, RunOptions, RunResult } from "./runner";
import {
  DeviceError,
  type ActionResult,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceToolchain,
  type Frame,
  type Point,
  type HumanInput,
  type PressKey,
  type SnapshotOptions,
  type Target,
} from "./types";
import { hitTest, parseSnapshot, type Size, type UiMap } from "./uiMap";

/** The helper version this driver is written against (output shapes verified live on this one). */
export const HELPER_VERSION = "0.21.23";
export const MIN_NODE = [22, 12] as const;
const SPRINGBOARD = "com.apple.springboard";

export type DriverToolchain = Omit<DeviceToolchain, "helper"> & {
  helper: DeviceToolchain["helper"] & {
    /** Why the helper cannot run at all (no Node.js, Node too old), when known. */
    reason?: string;
  };
};

export type DriverOptions = {
  run: CommandRunner;
  /** The app's data folder; the helper lives in `<appDataDir>/device-helper`. */
  appDataDir: string;
  /** Live frame format: JPEG is ~7x smaller and ~35% faster than PNG. Default "jpeg". */
  frameFormat?: "jpeg" | "png";
  /** Pause after actions the helper cannot settle itself (home, app switcher). Default 400. */
  quietMs?: number;
  /** Replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Now in ms; replaced in tests. */
  now?: () => number;
  nodeBin?: string;
  /**
   * The long-lived helper host (helperHost.ts). When given, iOS helper calls go through it instead of starting
   * `node agent-device.mjs` per call; any host failure falls back to the CLI. Absent: the CLI is always used.
   */
  host?: HelperHost;
  /**
   * The native simulator helper (nativeSim.ts): iOS touch, the home button and a pushed frame stream through
   * CoreSimulator, about 10x faster than simctl screenshots and the XCTest runner. Absent or unavailable: simctl
   * frames and the agent-device helper do everything, as before.
   */
  native?: NativeSim;
};

type Bound = string | undefined; // bundle id / package the helper session is open on

type DeviceState = {
  bound: Bound;
  /** The session must be (re)opened on this app before the next helper call. */
  wanted?: string;
  map?: UiMap;
  mapAt: number;
  points?: Size;
  /** Bumped when an action is queued: a snapshot may be shared only with callers that saw the same value. */
  seq: number;
  snap?: { seq: number; promise: Promise<UiMap>; background: boolean };
  /** A lookup of the app behind a tapped home-screen icon, still running after a fast tap returned. */
  iconFollow?: Promise<void>;
  frame?: Promise<Frame>;
  /** The native helper is being opened for this device (never awaited by frame(): simctl frames cover the wait). */
  nativeOpening?: Promise<void>;
  /** The session whose frame stream was started, and the last frame number handed out from it. */
  nativeStream?: { session: NativeSession; seq: number };
  /** A raw touch is down (streamed from the panel): where, and the timer that lifts it if the `up` never comes. */
  touchDown?: { from: Point; last: Point; timer: ReturnType<typeof setTimeout> };
};

const IOS_ID = /^[0-9A-F]{8}-(?:[0-9A-F]{4}-){3}[0-9A-F]{12}$/i;
export const isIosId = (id: string) => IOS_ID.test(id);

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const num = (n: number) => String(Math.round(n * 10) / 10);

/** Where adb and emulator live when they are not on PATH (appended, so the user's own PATH wins). */
const ANDROID_PATH =
  'export PATH="$PATH:${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools:${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator:${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}/platform-tools:${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}/emulator:$HOME/Library/Android/sdk/platform-tools:$HOME/Library/Android/sdk/emulator:$HOME/Android/Sdk/platform-tools:$HOME/Android/Sdk/emulator"; ';

/** Screen size in points from the pixels of a simulator screenshot when no snapshot has told us yet. */
export function guessPoints(pixels: Size): Size {
  const scale = pixels.width >= 1000 && pixels.width <= 1400 ? 3 : pixels.width > 1400 ? 2 : 2;
  return { width: Math.round(pixels.width / scale), height: Math.round(pixels.height / scale) };
}

export function createDriver(o: DriverOptions): DeviceDriver & {
  toolchain(): Promise<DriverToolchain>;
  helperPath: string;
} {
  const run = o.run;
  const dir = `${o.appDataDir.replace(/[\\/]+$/, "")}/device-helper`;
  const bin = `${dir}/node_modules/agent-device/bin/agent-device.mjs`;
  const node = o.nodeBin ?? "node";
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const quietMs = o.quietMs ?? 400;
  const queue = new KeyedQueue();
  const states = new Map<string, DeviceState>();
  const st = (id: string): DeviceState => {
    let s = states.get(id);
    if (!s) states.set(id, (s = { bound: undefined, mapAt: 0, seq: 0 }));
    return s;
  };

  // ---------- processes ----------

  async function sh(script: string, opts?: RunOptions): Promise<RunResult> {
    const r = await run(script, opts);
    if (r.timedOut) throw new DeviceError("The command took too long and was stopped.", "timeout");
    return r;
  }

  /** Runs a platform tool; "not installed" and "no such device" become the matching DeviceError. */
  async function tool(script: string, opts?: RunOptions) {
    const r = await sh(script, opts);
    if (r.code !== 0) throw toolFailure(r);
    return r;
  }

  const lastLine = (s: string) => s.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ").slice(0, 300);

  function toolFailure(r: RunResult): DeviceError {
    const text = `${r.stderr}\n${r.stdout}`;
    if (/xcrun: error|unable to find utility|xcode-select|command not found: xcrun|xcrun: not found/i.test(text))
      return new DeviceError("Xcode command line tools are not installed. Run `xcode-select --install`.", "toolchain");
    if (/adb: (command )?not found|adb: No such file|command not found: adb|emulator: (command )?not found/i.test(text))
      return new DeviceError(
        "Android platform-tools were not found. Install Android Studio or set ANDROID_HOME.",
        "toolchain",
      );
    if (/Invalid device|device not found|no devices\/emulators found|not found: |unknown device/i.test(text))
      return new DeviceError("That device is not available (it may have been deleted).", "no-device");
    return new DeviceError(lastLine(r.stderr) || lastLine(r.stdout) || `Command failed (${r.code}).`, "failed");
  }

  // ---------- the helper ----------

  let helperPresent: boolean | undefined;

  async function ensureHelper() {
    if (helperPresent) return;
    const r = await sh(`test -f ${shq(bin)} && echo yes || echo no`);
    helperPresent = r.stdout.trim() === "yes";
    if (!helperPresent)
      throw new DeviceError(
        "The device helper is not installed. Install it once from the Device panel (it adds a small npm package).",
        "helper-missing",
      );
  }

  const sessionName = (id: string) => `gustaf-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  const select = (id: string) =>
    isIosId(id) ? ["--udid", id, "--platform", "ios"] : ["--serial", id, "--platform", "android"];

  /** Commands that may be repeated through the CLI after the host died mid-call (they change nothing on the device). */
  const REPLAYABLE = new Set(["snapshot", "open", "close"]);

  async function helperRaw(id: string, args: string[], timeoutMs: number) {
    await ensureHelper();
    const argv = [...args, "--session", sessionName(id), ...select(id), "--json"];
    const host = o.host;
    if (host?.available && isIosId(id)) {
      try {
        const r = await host.call(argv, timeoutMs);
        if (!r.unsupported) {
          const viaHost = parseHelperReply(r.reply);
          if (viaHost) return viaHost;
        }
      } catch (e) {
        if (e instanceof HostError && e.dispatched && !REPLAYABLE.has(args[0])) {
          // The request may have reached the helper: running it again could tap twice.
          throw new DeviceError(
            e.code === "host-timeout"
              ? "The device did not answer in time."
              : "The device helper stopped during the action.",
            e.code === "host-timeout" ? "timeout" : "failed",
          );
        }
        // Not started, or harmless to repeat: the CLI below does it.
      }
    }
    const cmd = [node, bin, ...argv].map(shq).join(" ");
    const r = await sh(`${isIosId(id) ? "" : ANDROID_PATH}${cmd}`, { timeoutMs });
    const reply = parseHelperReply(r.stdout);
    if (!reply) {
      const text = `${r.stderr}\n${r.stdout}`;
      if (/Cannot find module|ERR_MODULE_NOT_FOUND|ENOENT.*agent-device/i.test(text)) {
        helperPresent = undefined;
        throw new DeviceError(
          "The device helper is damaged. Install it again from the Device panel.",
          "helper-missing",
        );
      }
      if (/node: (command )?not found|command not found: node/i.test(text))
        throw new DeviceError("Node.js was not found, the device helper needs Node.js 22.12 or newer.", "toolchain");
      throw new DeviceError(lastLine(r.stderr) || lastLine(r.stdout) || "The device helper gave no answer.", "failed");
    }
    return reply;
  }

  /** One helper call. A lost session (the helper's daemon went idle) is reopened once; errors become DeviceError. */
  async function helper(id: string, args: string[], timeoutMs = 30_000, reopen = true): Promise<HelperData> {
    const s = st(id);
    await s.iconFollow;
    if (s.wanted) await bind(id);
    const reply = await helperRaw(id, args, timeoutMs);
    if (reply.ok) return reply.data;
    if (reply.error.code === "SESSION_NOT_FOUND" && reopen) {
      s.bound = undefined;
      await bind(id);
      return helper(id, args, timeoutMs, false);
    }
    throw helperFailure(reply.error);
  }

  /** Opens the helper session on `wanted` (or the app it was on, or the home screen). */
  async function bind(id: string): Promise<void> {
    const s = st(id);
    const app = s.wanted ?? s.bound ?? (isIosId(id) ? SPRINGBOARD : await androidForeground(id));
    s.wanted = undefined;
    const reply = await helperRaw(id, ["open", app], 60_000);
    if (!reply.ok) {
      if (app !== SPRINGBOARD && isIosId(id)) {
        s.bound = undefined;
        s.wanted = SPRINGBOARD;
        return bind(id);
      }
      throw helperFailure(reply.error);
    }
    s.bound = app;
    // The snapshot `open` returns is taken while the app is still launching (sparse, odd viewport): not used.
  }

  async function androidForeground(id: string): Promise<string> {
    const r = await sh(`${ANDROID_PATH}adb -s ${shq(id)} shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'`, {
      timeoutMs: 15_000,
    });
    const m = /\s([A-Za-z][\w.]*)\/[\w.$]+/.exec(r.stdout);
    if (!m) throw new DeviceError("Could not tell which app is open. Open one with openApp first.", "failed");
    return m[1];
  }

  function remember(id: string, map: UiMap): UiMap {
    const s = st(id);
    s.map = map;
    s.mapAt = now();
    // The screen in points is the largest viewport seen (an on-screen keyboard shrinks the viewport).
    const v = map.viewport;
    if (v.width > 0 && v.height > 0 && (!s.points || v.height >= s.points.height || v.width !== s.points.width))
      s.points = { width: v.width, height: v.height };
    return map;
  }

  // ---------- toolchain, install ----------

  async function readVersion(): Promise<string | undefined> {
    const r = await sh(`cat ${shq(`${dir}/node_modules/agent-device/package.json`)} 2>/dev/null`);
    try {
      const v = JSON.parse(r.stdout).version;
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  }

  const nodeOk = (v: string) => {
    const m = /(\d+)\.(\d+)/.exec(v);
    return !!m && (+m[1] > MIN_NODE[0] || (+m[1] === MIN_NODE[0] && +m[2] >= MIN_NODE[1]));
  };

  async function toolchain(): Promise<DriverToolchain> {
    const [ios, android, version, nodeV] = await Promise.all([
      sh('[ "$(uname)" = Darwin ] || { echo NOT_MAC; exit 3; }; xcrun --find simctl', { timeoutMs: 15_000 }).catch(
        () => undefined,
      ),
      sh(`${ANDROID_PATH}command -v adb`, { timeoutMs: 15_000 }).catch(() => undefined),
      readVersion().catch(() => undefined),
      sh(`${shq(node)} -v`, { timeoutMs: 15_000 }).catch(() => undefined),
    ]);
    const iosOk = ios?.code === 0;
    const adbOk = android?.code === 0 && !!android.stdout.trim();
    const nodeVersion = nodeV?.code === 0 ? nodeV.stdout.trim() : undefined;
    let reason: string | undefined;
    if (!nodeVersion) reason = "Node.js was not found. The device helper needs Node.js 22.12 or newer.";
    else if (!nodeOk(nodeVersion))
      reason = `Node.js ${nodeVersion} is too old. The device helper needs 22.12 or newer.`;
    return {
      ios: iosOk
        ? { available: true }
        : {
            available: false,
            reason: ios?.stdout.includes("NOT_MAC")
              ? "iOS simulators need a Mac."
              : "Xcode is not installed or its command line tools are not selected. Install Xcode, then run `xcode-select --install`.",
          },
      android: adbOk
        ? { available: true }
        : {
            available: false,
            reason: "adb was not found. Install Android Studio (SDK Platform-Tools) or set ANDROID_HOME.",
          },
      helper: { installed: !!version, version, pinned: HELPER_VERSION, ...(reason ? { reason } : {}) },
    };
  }

  let installing: Promise<void> | undefined;

  function installHelper(onProgress?: (line: string) => void): Promise<void> {
    return (installing ??= (async () => {
      const nv = await sh(`${shq(node)} -v`, { timeoutMs: 15_000 });
      if (nv.code !== 0)
        throw new DeviceError("Node.js was not found. The device helper needs Node.js 22.12 or newer.", "toolchain");
      if (!nodeOk(nv.stdout))
        throw new DeviceError(
          `Node.js ${nv.stdout.trim()} is too old. The device helper needs 22.12 or newer.`,
          "toolchain",
        );
      onProgress?.(`Installing agent-device@${HELPER_VERSION} into ${dir}`);
      // The package has no install scripts and no dependencies, so scripts stay off. The exact version is pinned.
      const script =
        `mkdir -p ${shq(dir)} && cd ${shq(dir)} && ` +
        `{ [ -f package.json ] || printf '%s\\n' '{"name":"gustaf-device-helper","private":true}' > package.json; } && ` +
        `npm install agent-device@${HELPER_VERSION} --save-exact --ignore-scripts --no-audit --no-fund --loglevel=http 2>&1`;
      const r = await sh(script, { timeoutMs: 180_000, onLine: (l) => onProgress?.(l) });
      if (r.code !== 0)
        throw new DeviceError(
          `Installing the device helper failed: ${lastLine(r.stdout) || lastLine(r.stderr)}`,
          "failed",
        );
      const v = await readVersion();
      if (v !== HELPER_VERSION)
        throw new DeviceError(
          `The device helper installed as ${v ?? "nothing"}, expected ${HELPER_VERSION}.`,
          "failed",
        );
      helperPresent = undefined;
      onProgress?.(`Installed agent-device ${v}`);
    })().finally(() => {
      installing = undefined;
    }));
  }

  // ---------- devices ----------

  async function listIos(): Promise<DeviceInfo[]> {
    const r = await sh("xcrun simctl list devices available -j", { timeoutMs: 20_000 }).catch(() => undefined);
    return r?.code === 0 ? parseSimctlList(r.stdout) : [];
  }

  async function listAndroid(): Promise<DeviceInfo[]> {
    const [adb, emu] = await Promise.all([
      sh(`${ANDROID_PATH}adb devices -l`, { timeoutMs: 20_000 }).catch(() => undefined),
      sh(`${ANDROID_PATH}emulator -list-avds`, { timeoutMs: 20_000 }).catch(() => undefined),
    ]);
    const entries = adb?.code === 0 ? parseAdbDevices(adb.stdout) : [];
    const detail: Record<string, { avd?: string; release?: string }> = {};
    await Promise.all(
      entries
        .filter((e) => e.status === "device")
        .map(async (e) => {
          const [avd, rel] = await Promise.all([
            e.serial.startsWith("emulator-")
              ? sh(`${ANDROID_PATH}adb -s ${shq(e.serial)} emu avd name`, { timeoutMs: 10_000 }).catch(() => undefined)
              : undefined,
            sh(`${ANDROID_PATH}adb -s ${shq(e.serial)} shell getprop ro.build.version.release`, {
              timeoutMs: 10_000,
            }).catch(() => undefined),
          ]);
          detail[e.serial] = {
            avd: avd?.code === 0 ? avd.stdout.split(/\r?\n/)[0]?.trim() || undefined : undefined,
            release: rel?.code === 0 ? rel.stdout.trim() || undefined : undefined,
          };
        }),
    );
    return androidDevices(entries, emu?.code === 0 ? parseAvdList(emu.stdout) : [], detail);
  }

  async function list() {
    const [a, b] = await Promise.all([listIos(), listAndroid()]);
    return sortDevices([...a, ...b]);
  }

  async function boot(id: string) {
    const name = avdName(id);
    if (name !== undefined) {
      // A window that outlives this call; the new emulator shows up in list() as emulator-<port> once adb sees it.
      await tool(`${ANDROID_PATH}emulator -avd ${shq(name)}`, { detached: true });
      return;
    }
    if (!isIosId(id)) throw new DeviceError("This Android device is already running.", "failed");
    const r = await sh(`xcrun simctl boot ${shq(id)}`, { timeoutMs: 60_000 });
    if (r.code !== 0 && !/current state: Booted/i.test(r.stderr)) throw toolFailure(r);
    await tool(`xcrun simctl bootstatus ${shq(id)}`, { timeoutMs: 180_000 });
  }

  async function shutdown(id: string) {
    await release(id).catch(() => undefined);
    if (isIosId(id)) {
      const r = await sh(`xcrun simctl shutdown ${shq(id)}`, { timeoutMs: 60_000 });
      if (r.code !== 0 && !/current state: Shutdown/i.test(r.stderr)) throw toolFailure(r);
    } else await tool(`${ANDROID_PATH}adb -s ${shq(id)} emu kill`, { timeoutMs: 30_000 });
    states.delete(id);
  }

  // ---------- frame ----------

  /** The native session of an iOS simulator when one is open and healthy. Never starts anything. */
  const nativeFor = (id: string): NativeSession | undefined => (isIosId(id) ? o.native?.peek(id) : undefined);

  /** Starts opening the native helper in the background (compiling it the first time); at most one attempt at a time. */
  function kickNative(id: string) {
    const s = st(id);
    if (!o.native || !isIosId(id) || s.nativeOpening) return;
    s.nativeOpening = o.native
      .open(id)
      .then((ns) => {
        if (ns && !s.nativeStream) {
          ns.startFrames();
          s.nativeStream = { session: ns, seq: 0 };
        }
      })
      .catch(() => undefined)
      .finally(() => {
        s.nativeOpening = undefined;
      });
  }

  /** The next changed frame from the native stream (waits for it); undefined when the stream is not usable. */
  async function nativeFrame(id: string): Promise<Frame | undefined> {
    const s = st(id);
    const ns = nativeFor(id);
    if (!ns) {
      s.nativeStream = undefined;
      kickNative(id);
      return undefined;
    }
    if (s.nativeStream?.session !== ns) {
      ns.startFrames();
      s.nativeStream = { session: ns, seq: 0 };
    }
    const f = await ns.nextFrame(s.nativeStream.seq, 1000);
    if (!f) return undefined;
    s.nativeStream.seq = f.seq;
    const full = { width: f.pixelWidth, height: f.pixelHeight };
    return {
      data: f.data,
      mime: "image/jpeg",
      pixels: { width: f.width, height: f.height },
      points: s.points && sameAspect(s.points, full) ? s.points : guessPoints(full),
    };
  }

  function frame(id: string): Promise<Frame> {
    const s = st(id);
    return (s.frame ??= (async () => {
      const viaNative = await nativeFrame(id).catch(() => undefined);
      if (viaNative) return viaNative;
      const ios = isIosId(id);
      const fmt = o.frameFormat ?? "jpeg";
      const script = ios
        ? `xcrun simctl io ${shq(id)} screenshot --type=${fmt} - 2>/dev/null | base64 | tr -d '\\n'`
        : `${ANDROID_PATH}adb -s ${shq(id)} exec-out screencap -p | base64 | tr -d '\\n'`;
      const r = await sh(script, { timeoutMs: 15_000 });
      const data = r.stdout.trim();
      const info = data ? imageInfo(data) : null;
      if (r.code !== 0 || !info) {
        const whyNot = await sh(ios ? `xcrun simctl io ${shq(id)} enumerate 2>&1 | head -c 200` : "true", {
          timeoutMs: 5000,
        }).catch(() => undefined);
        throw new DeviceError(
          lastLine(r.stderr) ||
            (whyNot?.stdout ? lastLine(whyNot.stdout) : "") ||
            "Could not take a screenshot. Is the device booted?",
          "no-device",
        );
      }
      // Android coordinates are pixels, so its points are the pixels; iOS points come from the snapshot or a guess.
      const points = ios
        ? s.points && sameAspect(s.points, info.size)
          ? s.points
          : guessPoints(info.size)
        : info.size;
      return { data, mime: info.mime, pixels: info.size, points };
    })().finally(() => {
      s.frame = undefined;
    }));
  }

  const sameAspect = (a: Size, b: Size) => Math.abs(a.width / a.height - b.width / b.height) < 0.01;

  // ---------- snapshot ----------

  async function snapshotNow(id: string): Promise<UiMap> {
    let data = await helper(id, ["snapshot", "-i"], 45_000);
    // Right after an app launched or a transition the helper may only see a few nodes and says so: look again.
    for (let i = 0; i < 2 && settling(data); i++) {
      await sleep(600);
      data = await helper(id, ["snapshot", "-i"], 45_000);
    }
    return remember(id, parseSnapshot(data));
  }

  const settling = (data: HelperData) =>
    Array.isArray(data.nodes) && data.nodes.length <= 8 && JSON.stringify(data.warnings ?? "").includes("unverified");

  function snapshot(id: string, opts?: SnapshotOptions): Promise<UiMap> {
    const s = st(id);
    if (s.snap && s.snap.seq === s.seq) {
      // A caller that waits for the map keeps a shared background snapshot alive.
      if (!opts?.background) s.snap.background = false;
      return s.snap.promise;
    }
    const entry: NonNullable<DeviceState["snap"]> = {
      seq: s.seq,
      background: !!opts?.background,
      // An action queued after this snapshot (seq moved on) makes a still-waiting background snapshot pointless.
      promise: queue.run(id, () =>
        entry.background && s.seq !== entry.seq && s.map ? Promise.resolve(s.map) : snapshotNow(id),
      ),
    };
    s.snap = entry;
    const clear = () => {
      if (s.snap === entry) s.snap = undefined;
    };
    entry.promise.then(clear, clear);
    return entry.promise;
  }

  // ---------- actions ----------

  /** Serialised per device; later snapshot() calls queue behind it instead of joining an older one. */
  function act<T>(id: string, fn: () => Promise<T>): Promise<T> {
    st(id).seq++;
    return queue.run(id, fn);
  }

  const MAP_FRESH_MS = 10_000;

  /** Runs one helper action and builds the ActionResult from the helper's reply and a fresh snapshot. */
  async function action(
    id: string,
    args: string[],
    o2: {
      settle?: boolean;
      timeoutMs?: number;
      rebindFrom?: Target;
      pause?: boolean;
      onData?: (data: HelperData) => void;
    } = {},
  ): Promise<ActionResult> {
    const s = st(id);
    let before = s.map && now() - s.mapAt < MAP_FRESH_MS ? s.map : undefined;
    if (!before) before = await snapshotNow(id).catch(() => undefined);
    const hit = o2.rebindFrom && before ? targetNode(before, o2.rebindFrom) : undefined;
    const data = await helper(id, o2.settle ? [...args, "--settle"] : args, o2.timeoutMs ?? 45_000);
    o2.onData?.(data);
    if (o2.pause) await sleep(quietMs);
    // Tapping an app icon on the home screen moves the foreground; follow it.
    if (s.bound === SPRINGBOARD && hit?.label) {
      const bundle = await bundleForIcon(id, hit.label).catch(() => undefined);
      if (bundle) s.wanted = bundle;
    }
    let after: UiMap | undefined;
    try {
      if (s.wanted) await bind(id);
      after = await snapshotNow(id);
    } catch {
      after = undefined;
    }
    const settled = o2.settle ? data.settle?.settled !== false : true;
    const diff = before && after ? mapDiffText(before, after) : helperDiffText(data.settle);
    return { message: typeof data.message === "string" ? data.message : args[0], diff, settled };
  }

  function targetNode(map: UiMap, t: Target) {
    if ("ref" in t) return map.nodes.find((n) => n.ref === normRef(t.ref));
    return hitTest(map, t) ?? undefined;
  }

  const normRef = (r: string) => r.replace(/^@/, "");
  const targetArgs = (t: Target) => ("ref" in t ? [`@${normRef(t.ref)}`] : [num(t.x), num(t.y)]);

  // Installed apps and their names, to follow a tap on a home-screen icon (iOS only; cached for a minute).
  let apps: { at: number; id: string; names: Record<string, string[]> } | undefined;
  async function bundleForIcon(id: string, label: string): Promise<string | undefined> {
    if (!isIosId(id)) return undefined;
    if (!apps || apps.id !== id || now() - apps.at > 60_000) {
      const langs = parseLanguages(
        (await sh(`xcrun simctl spawn ${shq(id)} defaults read -g AppleLanguages`, { timeoutMs: 15_000 })).stdout,
      );
      const r = await sh(
        `xcrun simctl listapps ${shq(id)} | plutil -convert json -o - - | ${shq(node)} -e ${shq(APP_NAMES_SCRIPT)} ${shq(langs.join(","))}`,
        { timeoutMs: 20_000 },
      );
      let names: Record<string, string[]> = {};
      try {
        names = JSON.parse(r.stdout);
      } catch {
        /* no names: the session just stays on the home screen */
      }
      apps = { at: now(), id, names };
    }
    const bundle = bundleForLabel(apps.names, label);
    return bundle === SPRINGBOARD ? undefined : bundle;
  }

  const tap = (id: string, t: Target) =>
    act(id, () => action(id, ["press", ...targetArgs(t)], { settle: true, rebindFrom: t }));

  const longPress = (id: string, t: Target, ms?: number) =>
    act(id, () =>
      action(id, ["longpress", ...targetArgs(t), ...(ms ? [String(Math.round(ms))] : [])], {
        settle: true,
        rebindFrom: t,
      }),
    );

  const swipe = (id: string, from: Point, to: Point, ms?: number) =>
    act(id, () =>
      action(
        id,
        ms
          ? ["gesture", "pan", num(from.x), num(from.y), num(to.x - from.x), num(to.y - from.y), String(Math.round(ms))]
          : ["swipe", num(from.x), num(from.y), num(to.x), num(to.y)],
        { pause: true },
      ),
    );

  const type = (id: string, text: string) => act(id, () => action(id, ["type", text]));

  const fill = (id: string, t: Target, text: string) =>
    act(id, () => action(id, ["fill", ...targetArgs(t), text], { settle: true }));

  const scroll = (id: string, direction: "up" | "down" | "left" | "right", amount?: number) =>
    act(id, () =>
      action(id, ["scroll", direction, ...(amount != null ? [String(Math.min(0.8, Math.max(0.05, amount)))] : [])], {
        settle: true,
      }),
    );

  async function volumeKey(id: string, key: "volume-up" | "volume-down"): Promise<ActionResult> {
    if (isIosId(id)) throw new DeviceError("The iOS simulator has no volume buttons.", "failed");
    await tool(`${ANDROID_PATH}adb -s ${shq(id)} shell input keyevent ${key === "volume-up" ? 24 : 25}`, {
      timeoutMs: 10_000,
    });
    return { message: key === "volume-up" ? "Volume up" : "Volume down", diff: "", settled: true };
  }

  const press = (id: string, key: PressKey) =>
    act(id, async () => {
      const ios = isIosId(id);
      switch (key) {
        case "home": {
          const r = await action(id, ["home"], {
            pause: true,
            onData: () => void (ios && (st(id).wanted = SPRINGBOARD)),
          });
          return r;
        }
        case "back":
          return action(id, ios ? ["back"] : ["back", "--system"], { settle: true });
        case "enter":
          return action(id, ios ? ["type", "\n"] : ["keyboard", "enter"]);
        case "app-switcher":
          return action(id, ["app-switcher"], { pause: true });
        case "volume-up":
        case "volume-down":
          return volumeKey(id, key);
      }
    });

  const openApp = (id: string, app: string) =>
    act(id, async () => {
      const s = st(id);
      const before = s.map && now() - s.mapAt < MAP_FRESH_MS ? s.map : undefined;
      // `open` is idempotent: it brings the app to the front and rebinds the helper session to it.
      s.wanted = undefined;
      const reply = await helperRaw(id, ["open", app, "--foreground"], 60_000);
      let data = reply.ok ? reply.data : undefined;
      if (!reply.ok && reply.error.code === "SESSION_NOT_FOUND")
        data = await helperRaw(id, ["open", app], 60_000).then((r) => (r.ok ? r.data : undefined));
      if (!data) throw reply.ok ? new DeviceError("Could not open the app.", "failed") : helperFailure(reply.error);
      s.bound = typeof data.appBundleId === "string" ? data.appBundleId : app;
      const after = await snapshotNow(id).catch(() => undefined);
      return {
        message: typeof data.message === "string" ? data.message : `Opened ${data.appName ?? app}`,
        diff: before && after ? mapDiffText(before, after) : "",
        settled: true,
      } satisfies ActionResult;
    });

  // ---------- fast input for a person at the panel ----------

  /** One helper call for a person: no settle, no snapshot before or after. The cached map is marked old. */
  async function quick(id: string, args: string[], timeoutMs = 20_000): Promise<ActionResult> {
    const s = st(id);
    const data = await helper(id, args, timeoutMs);
    s.mapAt = 0;
    return { message: typeof data.message === "string" ? data.message : args[0], diff: "", settled: true };
  }

  /** A tap on a home-screen icon moves the foreground; find the app in the background, the next helper call waits for it. */
  function followIcon(id: string, t: Target) {
    const s = st(id);
    const hit = s.bound === SPRINGBOARD && s.map ? targetNode(s.map, t) : undefined;
    if (!hit?.label) return;
    s.iconFollow = bundleForIcon(id, hit.label)
      .then((bundle) => void (bundle && (s.wanted = bundle)))
      .catch(() => undefined);
  }

  /** The drag a person made, replayed as one timed pan: 80..400 ms, so a flick stays a flick. */
  const panDuration = (ms?: number) => Math.min(400, Math.max(80, Math.round(ms ?? 120)));

  /** The screen in points, for the native helper: the snapshot's viewport, else guessed from the framebuffer. */
  const screenOf = (id: string, ns: NativeSession) => {
    const p = st(id).points ?? guessPoints({ width: ns.pixelWidth, height: ns.pixelHeight });
    return { sw: p.width, sh: p.height };
  };

  /** Where a target is on screen: a point as given, a ref as the centre of its element in the last map. */
  function targetPoint(id: string, t: Target): Point | undefined {
    if (!("ref" in t)) return t;
    const n = st(id).map?.nodes.find((x) => x.ref === normRef(t.ref));
    return n ? { x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 } : undefined;
  }

  /** Runs `fn` on the native session; any failure of the native path means "use the helper instead" (undefined). */
  async function viaNative(
    id: string,
    t: Target | undefined,
    fn: (ns: NativeSession, at: Point | undefined) => Promise<string>,
  ): Promise<ActionResult | undefined> {
    const ns = nativeFor(id);
    if (!ns) return undefined;
    const at = t ? targetPoint(id, t) : undefined;
    if (t && !at) return undefined;
    try {
      const message = await fn(ns, at);
      st(id).mapAt = 0;
      return { message, diff: "", settled: true };
    } catch {
      return undefined;
    }
  }

  const where = (p: Point) => `(${Math.round(p.x)}, ${Math.round(p.y)})`;

  const human: HumanInput = {
    tap: (id, t) =>
      act(id, async () => {
        followIcon(id, t);
        return (
          (await viaNative(id, t, async (ns, at) => {
            await ns.tap(at!.x, at!.y, screenOf(id, ns));
            return `Tapped ${where(at!)}`;
          })) ?? quick(id, ["press", ...targetArgs(t)])
        );
      }),
    longPress: (id, t, ms) =>
      act(id, async () => {
        followIcon(id, t);
        return (
          (await viaNative(id, t, async (ns, at) => {
            await ns.tap(at!.x, at!.y, screenOf(id, ns), Math.min(5000, Math.max(400, ms ?? 600)));
            return `Long-pressed ${where(at!)}`;
          })) ?? quick(id, ["longpress", ...targetArgs(t), ...(ms ? [String(Math.round(ms))] : [])])
        );
      }),
    swipe: (id, from, to, ms) =>
      act(id, async () => {
        return (
          (await viaNative(id, undefined, async (ns) => {
            await ns.swipe(from, to, Math.min(600, Math.max(60, Math.round(ms ?? 140))), screenOf(id, ns));
            return `Swiped ${where(from)} to ${where(to)}`;
          })) ??
          quick(id, [
            "gesture",
            "pan",
            num(from.x),
            num(from.y),
            num(to.x - from.x),
            num(to.y - from.y),
            String(panDuration(ms)),
          ])
        );
      }),
    type: (id, text) => act(id, () => quick(id, ["type", text])),
    fill: (id, t, text) => act(id, () => quick(id, ["fill", ...targetArgs(t), text])),
    scroll: (id, direction, amount) =>
      act(id, () =>
        quick(id, ["scroll", direction, ...(amount != null ? [String(Math.min(0.8, Math.max(0.05, amount)))] : [])]),
      ),
    press: (id, key) =>
      act(id, async () => {
        const ios = isIosId(id);
        switch (key) {
          case "home": {
            const r =
              (await viaNative(id, undefined, async (ns) => {
                await ns.button("home");
                return "Home";
              })) ?? (await quick(id, ["home"]));
            if (ios) st(id).wanted = SPRINGBOARD;
            return r;
          }
          case "back":
            return quick(id, ios ? ["back"] : ["back", "--system"]);
          case "enter":
            return (
              (await viaNative(id, undefined, async (ns) => {
                await ns.key(40);
                return "Enter";
              })) ?? quick(id, ios ? ["type", "\n"] : ["keyboard", "enter"])
            );
          case "app-switcher":
            return quick(id, ["app-switcher"]);
          default:
            return volumeKey(id, key);
        }
      }),
    touch(id, phase, at) {
      const ns = nativeFor(id);
      if (!ns) return false;
      const s = st(id);
      const screen = screenOf(id, ns);
      if (phase === "down") {
        if (s.touchDown) clearTimeout(s.touchDown.timer);
        s.touchDown = {
          from: at,
          last: at,
          timer: setTimeout(() => human.touch?.(id, "up", s.touchDown?.last ?? at), 8000),
        };
      } else if (!s.touchDown) {
        return false; // a move or an up without a down that we sent: not ours
      } else s.touchDown.last = at;
      ns.touch(phase, at.x, at.y, screen);
      if (phase === "up") {
        const from = s.touchDown?.from;
        if (s.touchDown) clearTimeout(s.touchDown.timer);
        s.touchDown = undefined;
        s.mapAt = 0;
        if (from) followIcon(id, from);
      }
      return true;
    },
  };

  async function release(id: string) {
    const s = states.get(id);
    states.delete(id);
    if (s?.touchDown) clearTimeout(s.touchDown.timer);
    void o.native?.close(id);
    if (!s?.bound && !s?.wanted) return;
    await queue.run(id, async () => {
      if (!(await sh(`test -f ${shq(bin)} && echo yes || echo no`)).stdout.includes("yes")) return;
      await helperRaw(id, ["close"], 20_000).catch(() => undefined);
    });
  }

  return {
    human,
    streaming: (id: string) => !!nativeFor(id) && !!st(id).nativeStream,
    helperPath: bin,
    toolchain,
    installHelper,
    list,
    boot,
    shutdown,
    frame,
    snapshot,
    tap,
    longPress,
    swipe,
    type,
    fill,
    press,
    scroll,
    openApp,
    release,
  };
}
