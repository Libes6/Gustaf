// @effect-diagnostics nodeBuiltinImport:off - A static scan of the repository sources.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import { cliReleaseAssetUrl, cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import {
  GUSTAF_CLOUD_API_URL,
  GUSTAF_INSTALL_PS1_URL,
  GUSTAF_INSTALL_SCRIPT_URL,
  GUSTAF_MODEL_MANIFEST_URL,
  GUSTAF_RELEASES_URL,
  GUSTAF_REPOSITORY_URL,
} from "@t3tools/shared/gustafService";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(import.meta.url), "../..");

describe("Gustaf service addresses", () => {
  it("point at the Gustaf repository and cloud", () => {
    expect(GUSTAF_REPOSITORY_URL).toBe("https://github.com/Libes6/Gustaf");
    expect(GUSTAF_RELEASES_URL).toBe("https://github.com/Libes6/Gustaf/releases");
    expect(GUSTAF_CLOUD_API_URL).toBe("https://api.libes6.ru");
    for (const url of [
      GUSTAF_INSTALL_SCRIPT_URL,
      GUSTAF_INSTALL_PS1_URL,
      GUSTAF_MODEL_MANIFEST_URL,
    ]) {
      expect(url.startsWith("https://raw.githubusercontent.com/Libes6/Gustaf/")).toBe(true);
    }
  });

  it("download CLI archives and read the release index from Gustaf releases", () => {
    expect(cliReleaseAssetUrl("1.2.3", "SHA256SUMS")).toBe(
      "https://github.com/Libes6/Gustaf/releases/download/v1.2.3/SHA256SUMS",
    );
    expect(cliReleaseIndexPageUrl(1)).toBe(
      "https://api.github.com/repos/Libes6/Gustaf/releases?per_page=100&page=1",
    );
  });

  it.each([
    "apps/desktop/src/gustaf/GustafCloudApi.ts",
    "apps/mobile/src/features/account/accountApi.ts",
    "apps/server/src/relay/RelayAccount.ts",
  ])("default every client's Gustaf Cloud address to the shared one: %s", (file) => {
    expect(readSource(file)).toContain(`"${GUSTAF_CLOUD_API_URL}"`);
  });
});

/**
 * Hosts of T3 Code's own services, plus the T3 GitHub organization. Gustaf must not call them;
 * a new runtime reference needs an entry below that says why it is safe.
 */
const T3_SERVICE = /(?<![\w-])(?:[\w-]+\.)*t3\.(?:codes|chat|sh)\b|pingdotgg|t3tools\.com/u;

const ALLOWED: Readonly<Record<string, string>> = {
  "apps/mobile/src/features/showcase/showcaseEnvironmentRows.ts":
    "Sample rows for store screenshots.",
  "apps/web/src/components/clerk/T3ChatUserProfilePage.tsx":
    "T3 Connect account page; rendered only when hasCloudPublicConfig() is true, which no Gustaf build is.",
  "apps/web/src/components/clerk/T3ConnectUserProfilePage.tsx":
    "T3 Connect account page; rendered only when hasCloudPublicConfig() is true.",
  "apps/web/src/components/cloud/TunnelUsage.tsx":
    "T3 Connect plan link; rendered only when hasCloudPublicConfig() is true.",
  "packages/contracts/src/environmentHttp.ts":
    "Troubleshooting doc link attached to T3 Connect errors.",
};

const SCANNED_ROOTS = [
  "apps/desktop/src",
  "apps/server/src",
  "apps/web/src",
  "apps/mobile/src",
  "apps/mobile/app.config.ts",
  "packages",
  "scripts/install.sh",
  "scripts/install.ps1",
  "scripts/npm-launcher",
  "scripts/build-desktop-artifact.ts",
];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".cjs", ".sh", ".ps1"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-electron", "translations"]);
const TEST_FILE =
  /\.(?:test|browser\.test|e2e)\.[cm]?[jt]sx?$|[\\/]testkit[\\/]|[\\/]testUtils[\\/]/u;

function* sourceFiles(relativePath: string): Generator<string> {
  const absolute = NodePath.join(REPO_ROOT, relativePath);
  const stat = NodeFS.statSync(absolute);
  if (stat.isFile()) {
    yield relativePath;
    return;
  }
  for (const entry of NodeFS.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const child = NodePath.posix.join(relativePath, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(child);
    else if (SOURCE_EXTENSIONS.has(NodePath.extname(entry.name)) && !TEST_FILE.test(child)) {
      yield child;
    }
  }
}

function readSource(relativePath: string): string {
  return NodeFS.readFileSync(NodePath.join(REPO_ROOT, relativePath), "utf8");
}

describe("runtime code", () => {
  it("references no T3 Code service host outside the explained allowlist", () => {
    const offenders: string[] = [];
    const used = new Set<string>();
    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(root)) {
        if (!T3_SERVICE.test(readSource(file))) continue;
        if (file in ALLOWED) used.add(file);
        else offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    // A stale entry would hide a later regression in that file.
    expect(Object.keys(ALLOWED).filter((file) => !used.has(file))).toEqual([]);
  });
});
