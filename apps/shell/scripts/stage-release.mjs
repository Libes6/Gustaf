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
const staged = new Set();
function walk(dir) {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const file = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else {
      const name = releaseAssetName(platform, version, entry.name);
      if (name === null) continue;
      // Rename payload and signature together; bytes and signatures stay unchanged.
      if (staged.has(name)) throw Error(`Duplicate release asset: ${name}`);
      staged.add(name);
      NodeFS.copyFileSync(file, NodePath.join("release-assets", name));
    }
  }
}
walk(source);
