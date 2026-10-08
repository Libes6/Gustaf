// Parsers for the device lists of the platform tools: `xcrun simctl list devices available -j`, `adb devices -l` and
// `emulator -list-avds`. Pure, no I/O. Unknown input gives an empty list, never throws.

import type { DeviceInfo, DeviceState } from "./types";

type SimDevice = { udid?: string; name?: string; state?: string; isAvailable?: boolean };

const simState = (s: string | undefined): DeviceState => {
  switch (s) {
    case "Booted":
      return "booted";
    case "Booting":
      return "booting";
    case "Shutdown":
      return "shutdown";
    default:
      return "unknown"; // "Shutting Down", "Creating"...
  }
};

const order = { booted: 0, booting: 1, unknown: 2, shutdown: 3 } as const;
export const sortDevices = (list: DeviceInfo[]) =>
  [...list].sort(
    (a, b) => order[a.state] - order[b.state] || a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name),
  );

/** iOS simulators from `simctl list devices available -j`; only iOS runtimes (iPhone and iPad), not watchOS / tvOS / visionOS. */
export function parseSimctlList(stdout: string): DeviceInfo[] {
  let data: { devices?: Record<string, SimDevice[]> };
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out: DeviceInfo[] = [];
  for (const [runtime, devices] of Object.entries(data.devices ?? {})) {
    const m = /SimRuntime\.iOS-(\d+)(?:-(\d+))?/.exec(runtime);
    if (!m || !Array.isArray(devices)) continue;
    const os = `iOS ${m[1]}${m[2] ? `.${m[2]}` : ""}`;
    for (const d of devices) {
      if (!d?.udid || !d.name || d.isAvailable === false) continue;
      out.push({ id: d.udid, name: d.name, platform: "ios", state: simState(d.state), os });
    }
  }
  return sortDevices(out);
}

export type AdbEntry = { serial: string; status: string; model?: string; usb: boolean };

/** `adb devices -l`: one entry per attached device or running emulator. */
export function parseAdbDevices(stdout: string): AdbEntry[] {
  const out: AdbEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m =
      /^(\S+)\s+(device|offline|unauthorized|authorizing|recovery|sideload|bootloader|no permissions[^\s]*)\b(.*)$/.exec(
        line.trim(),
      );
    if (!m) continue; // header, "* daemon started" noise, blank lines
    const model = /\bmodel:(\S+)/.exec(m[3])?.[1];
    out.push({ serial: m[1], status: m[2], model, usb: /\busb:/.test(m[3]) });
  }
  return out;
}

/** AVD names from `emulator -list-avds` (one per line; the emulator may print INFO lines first). */
export function parseAvdList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9_.\- ]+$/.test(l) && !/^(INFO|WARNING|ERROR)\b/.test(l));
}

/** The id the driver gives an emulator image that is not running yet. */
export const avdId = (name: string) => `avd:${name}`;
export const avdName = (id: string) => (id.startsWith("avd:") ? id.slice(4) : undefined);

const androidState = (status: string): DeviceState =>
  status === "device" ? "booted" : status === "offline" || status === "authorizing" ? "booting" : "unknown";

export type AndroidDetail = { avd?: string; release?: string };

/**
 * Android devices: running ones from adb (an emulator is named after its AVD when known), plus every AVD that is not
 * running as a shutdown device with id `avd:<name>`.
 */
export function androidDevices(
  adb: AdbEntry[],
  avds: string[],
  detail: Record<string, AndroidDetail> = {},
): DeviceInfo[] {
  const out: DeviceInfo[] = [];
  const running = new Set<string>();
  for (const e of adb) {
    const d = detail[e.serial] ?? {};
    if (d.avd) running.add(d.avd);
    const name = d.avd?.replace(/_/g, " ") ?? e.model?.replace(/_/g, " ") ?? e.serial;
    out.push({
      id: e.serial,
      name,
      platform: "android",
      state: androidState(e.status),
      os: d.release ? `Android ${d.release}` : undefined,
    });
  }
  for (const name of avds)
    if (!running.has(name))
      out.push({ id: avdId(name), name: name.replace(/_/g, " "), platform: "android", state: "shutdown" });
  return sortDevices(out);
}
