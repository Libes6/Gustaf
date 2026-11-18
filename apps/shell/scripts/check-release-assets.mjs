import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { platforms } from "./release-manifest.mjs";

// Per platform, the staged asset suffixes the release cannot ship without (Intel Macs are unsupported).
const required = {
  "darwin-aarch64": [".dmg", ".app.tar.gz", ".app.tar.gz.sig"],
  "windows-x86_64": ["-setup.exe", "-setup.exe.sig"],
  "linux-x86_64": [".AppImage", ".AppImage.sig"],
};

export function missingReleaseAssets(version, files, { manifest = true } = {}) {
  const missing = [];
  for (const platform of platforms) {
    const names = files[platform] ?? [];
    for (const suffix of required[platform]) {
      const found = names.some(
        (name) => name.startsWith(`Gustaf-${version}-`) && name.endsWith(suffix),
      );
      if (!found) missing.push(`${platform}: *${suffix}`);
    }
  }
  if (manifest && !(files.root ?? []).includes("latest.json")) missing.push("latest.json");
  const browserArchive = `gustaf-browser-${version}-darwin-arm64.tar.xz`;
  if (!(files.root ?? []).includes(browserArchive)) missing.push(browserArchive);
  return missing;
}

export function listReleaseAssets(directory) {
  const files = {};
  for (const platform of platforms) {
    const dir = NodePath.join(directory, platform);
    files[platform] = NodeFS.existsSync(dir) ? NodeFS.readdirSync(dir) : [];
  }
  files.root = NodeFS.existsSync(directory) ? NodeFS.readdirSync(directory) : [];
  return files;
}

if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  const [directory, version, mode] = process.argv.slice(2);
  const missing = missingReleaseAssets(version, listReleaseAssets(directory), {
    manifest: mode !== "--no-manifest",
  });
  if (missing.length > 0) {
    console.error(
      `Release ${version} is missing required assets:\n${missing.map((m) => `  - ${m}`).join("\n")}`,
    );
    process.exit(1);
  }
}
