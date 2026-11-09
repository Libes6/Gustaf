import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const semver = /^\d+\.\d+\.\d+$/;
export const platforms = ["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "linux-x86_64"];
export const targets = [...platforms, "windows-x86_64-msi"];
export function manifest(version, assets, notes = "", date = new Date().toISOString()) {
  if (!semver.test(version) || Number.isNaN(Date.parse(date)))
    throw Error("Invalid release version/date");
  const result = { version, notes, pub_date: date, platforms: {} };
  const names = new Set();
  for (const platform of targets) {
    const asset = assets[platform];
    const ext = platform.startsWith("darwin")
      ? ".app.tar.gz"
      : platform.endsWith("-msi")
        ? ".msi"
        : platform.startsWith("windows")
          ? ".exe"
          : ".AppImage";
    if (
      !asset ||
      !asset.name.endsWith(ext) ||
      names.has(asset.name) ||
      !asset.signature?.trim() ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(asset.signature.trim()) ||
      !asset.size
    )
      throw Error(`Missing/invalid signed artifact: ${platform}`);
    names.add(asset.name);
    result.platforms[platform] = {
      signature: asset.signature.trim(),
      url: `https://github.com/Libes6/Gustaf/releases/download/v${version}/${encodeURIComponent(asset.name)}`,
    };
  }
  return result;
}
if (
  process.argv[1] &&
  NodeFS.realpathSync(process.argv[1]) ===
    NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
) {
  const [directory, version, notesFile] = process.argv.slice(2);
  const assets = {};
  for (const platform of targets) {
    const dir = NodePath.join(directory, platform.endsWith("-msi") ? "windows-x86_64" : platform);
    const candidates = NodeFS
      .readdirSync(dir)
      .filter((name) =>
        name.endsWith(
          platform.startsWith("darwin")
            ? ".app.tar.gz"
            : platform.endsWith("-msi")
              ? ".msi"
              : platform.startsWith("windows")
                ? ".exe"
                : ".AppImage",
        ),
      );
    if (candidates.length !== 1) throw Error(`Expected one updater artifact: ${platform}`);
    const name = candidates[0];
    assets[platform] = {
      name,
      size: NodeFS.statSync(NodePath.join(dir, name)).size,
      signature: NodeFS.readFileSync(NodePath.join(dir, name + ".sig"), "utf8"),
    };
  }
  NodeFS.writeFileSync(
    NodePath.join(directory, "latest.json"),
    JSON.stringify(
      manifest(version, assets, notesFile ? NodeFS.readFileSync(notesFile, "utf8") : ""),
      null,
      2,
    ) + "\n",
  );
}
