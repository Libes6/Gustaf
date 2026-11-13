import type { DeviceKind, Overview } from "../api/types";
import { strings } from "../strings";

type VersionRow = Overview["versions"][number];

export interface VersionGroup {
  readonly kind: DeviceKind;
  readonly total: number;
  /** Newest first; the first entry is the latest version any device of this kind reports. */
  readonly versions: ReadonlyArray<{
    readonly version: string;
    readonly devices: number;
    readonly platforms: ReadonlyArray<{ readonly platform: string; readonly devices: number }>;
  }>;
}

function parts(version: string) {
  const [core = "", prerelease] = version.split(/[-+]/, 2);
  return { numbers: core.split(".").map((part) => Number.parseInt(part, 10) || 0), prerelease };
}

/** Semver-like order: numeric parts first, then a release before its prereleases. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.numbers.length, right.numbers.length); index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  return left.prerelease.localeCompare(right.prerelease, "en", { numeric: true });
}

export function groupVersions(rows: Overview["versions"]): ReadonlyArray<VersionGroup> {
  const kinds: DeviceKind[] = ["computer", "phone"];
  return kinds.flatMap((kind) => {
    const byVersion = new Map<string, VersionRow[]>();
    for (const row of rows) {
      if (row.kind !== kind) continue;
      byVersion.set(row.version, [...(byVersion.get(row.version) ?? []), row]);
    }
    if (byVersion.size === 0) return [];
    const versions = [...byVersion]
      .map(([version, platformRows]) => ({
        version,
        devices: platformRows.reduce((sum, row) => sum + row.devices, 0),
        platforms: platformRows
          .map(({ platform, devices }) => ({ platform, devices }))
          .toSorted((a, b) => b.devices - a.devices || a.platform.localeCompare(b.platform)),
      }))
      .toSorted((a, b) => compareVersions(b.version, a.version));
    return [{ kind, total: versions.reduce((sum, row) => sum + row.devices, 0), versions }];
  });
}

const OS_NAMES: Record<string, string> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  android: "Android",
  ios: "iOS",
};

/** `macos-arm64` → `macOS arm64`; unknown values are shown as sent. */
export function formatPlatform(platform: string | null): string {
  if (!platform) return strings.common.unknown;
  const [os = "", arch] = platform.split("-", 2);
  const name = OS_NAMES[os] ?? os;
  return arch ? `${name} ${arch}` : name;
}

/** What the device last reported, or that it has not reported yet. */
export function formatDeviceBuild(device: {
  readonly appVersion: string | null;
  readonly platform: string | null;
}): string {
  if (!device.appVersion) return strings.devices.notReported;
  return `${device.appVersion} · ${formatPlatform(device.platform)}`;
}
