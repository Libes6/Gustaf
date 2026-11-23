import { describe, expect, it } from "vite-plus/test";

import { strings } from "../strings";
import { compareVersions, formatDeviceBuild, formatPlatform, groupVersions } from "./versions";

describe("device versions", () => {
  it("orders versions numerically, releases after their prereleases", () => {
    expect(
      ["0.9.0", "0.10.0", "0.9.1", "1.0.0-beta.2", "1.0.0", "1.0.0-beta.10"].toSorted(
        compareVersions,
      ),
    ).toEqual(["0.9.0", "0.9.1", "0.10.0", "1.0.0-beta.2", "1.0.0-beta.10", "1.0.0"]);
  });

  it("groups by kind, newest version first, with per-platform counts", () => {
    const groups = groupVersions([
      { kind: "computer", platform: "macos-arm64", version: "0.9.0", devices: 3 },
      { kind: "computer", platform: "windows-x64", version: "0.10.0", devices: 1 },
      { kind: "computer", platform: "macos-arm64", version: "0.10.0", devices: 2 },
      { kind: "phone", platform: "android", version: "1.0.0", devices: 4 },
    ]);
    expect(groups).toEqual([
      {
        kind: "computer",
        total: 6,
        versions: [
          {
            version: "0.10.0",
            devices: 3,
            platforms: [
              { platform: "macos-arm64", devices: 2 },
              { platform: "windows-x64", devices: 1 },
            ],
          },
          { version: "0.9.0", devices: 3, platforms: [{ platform: "macos-arm64", devices: 3 }] },
        ],
      },
      {
        kind: "phone",
        total: 4,
        versions: [
          { version: "1.0.0", devices: 4, platforms: [{ platform: "android", devices: 4 }] },
        ],
      },
    ]);
    expect(groupVersions([])).toEqual([]);
  });

  it("labels platforms and devices that never reported", () => {
    expect(formatPlatform("macos-arm64")).toBe("macOS arm64");
    expect(formatPlatform("android")).toBe("Android");
    expect(formatPlatform("plan9-mips")).toBe("plan9 mips");
    expect(formatDeviceBuild({ appVersion: "0.9.0", platform: "windows-x64" })).toBe(
      "0.9.0 · Windows x64",
    );
    expect(formatDeviceBuild({ appVersion: null, platform: null })).toBe(
      strings.devices.notReported,
    );
  });
});
