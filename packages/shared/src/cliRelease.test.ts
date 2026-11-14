import { describe, expect, it } from "vite-plus/test";

import {
  CLI_RELEASE_CHECKSUMS_FILE,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliArchiveTarCommand,
  cliExecutableName,
  cliInstallCommand,
  cliReleaseAssetUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  gustaf-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *gustaf-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("gustaf-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("gustaf-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("names the Gustaf archive for each desktop platform and none for the rest", () => {
    expect(
      (
        [
          ["darwin", "arm64"],
          ["linux", "x64"],
          ["win32", "x64"],
          ["darwin", "x64"],
          ["linux", "arm64"],
          ["win32", "arm64"],
        ] as const
      ).map(([platform, arch]) => {
        const key = cliArchivePlatformKey(platform, arch);
        return key === undefined ? undefined : cliArchiveFileName("1.2.3", key);
      }),
    ).toEqual([
      "gustaf-1.2.3-darwin-arm64.tar.gz",
      "gustaf-1.2.3-linux-x64.tar.gz",
      "gustaf-1.2.3-win32-x64.zip",
      undefined,
      undefined,
      undefined,
    ]);
    expect([cliExecutableName("linux"), cliExecutableName("win32")]).toEqual([
      "gustaf",
      "gustaf.exe",
    ]);
  });

  it("downloads from Gustaf's releases unless a mirror is set", () => {
    expect(cliReleaseAssetUrl("1.2.3", CLI_RELEASE_CHECKSUMS_FILE)).toBe(
      "https://github.com/Libes6/Gustaf/releases/download/v1.2.3/SHA256SUMS.txt",
    );
    expect(
      cliReleaseAssetUrl("1.2.3", "gustaf-1.2.3-linux-x64.tar.gz", "https://mirror.example/dl/"),
    ).toBe("https://mirror.example/dl/v1.2.3/gustaf-1.2.3-linux-x64.tar.gz");
    expect(cliReleaseIndexPageUrl(2)).toBe(
      "https://api.github.com/repos/Libes6/Gustaf/releases?per_page=100&page=2",
    );
    expect(cliInstallCommand("darwin", "1.2.3")).toBe(
      "curl -fsSL https://raw.githubusercontent.com/Libes6/Gustaf/main/scripts/install.sh | T3CODE_VERSION=1.2.3 sh",
    );
    expect(cliInstallCommand("win32")).toBe(
      "irm https://raw.githubusercontent.com/Libes6/Gustaf/main/scripts/install.ps1 | iex",
    );
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "v1.2.4-preview.20260912.8" },
      { tag_name: "v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      { tag_name: "v1.2.3" },
      { tag_name: "v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "v1.2.3" }], "preview")).toBeUndefined();
  });
});
