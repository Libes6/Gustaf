import * as NodeProcess from "node:process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { platforms } from "./release-manifest.mjs";
import { releaseAssetName } from "./release-asset-name.mjs";
const platform = process.argv[2];
if (!platforms.includes(platform)) throw Error("Unsupported platform");
const host = `${NodeProcess.platform === "win32" ? "windows" : NodeProcess.platform}-${NodeProcess.arch === "arm64" ? "aarch64" : NodeProcess.arch === "x64" ? "x86_64" : NodeProcess.arch}`;
if (host !== platform)
  throw Error(`Runner architecture mismatch: expected ${platform}, got ${host}`);
const source = "apps/shell/src-tauri/target/release/bundle";
const { version } = JSON.parse(NodeFS.readFileSync("apps/shell/src-tauri/tauri.conf.json", "utf8"));
NodeFS.mkdirSync("release-assets", { recursive: true });
const directories = platform.startsWith("darwin")
  ? ["macos", "dmg"]
  : platform.startsWith("windows")
    ? ["nsis", "msi"]
    : ["appimage", "deb", "rpm"];

for (const directory of directories) {
  const bundle = NodePath.join(source, directory);
  for (const entry of NodeFS.readdirSync(bundle, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = releaseAssetName(platform, version, entry.name);
    if (name === null) continue;
    NodeFS.copyFileSync(
      NodePath.join(bundle, entry.name),
      NodePath.join("release-assets", name),
      NodeFS.constants.COPYFILE_EXCL,
    );
  }
}
