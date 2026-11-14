// Gives the bundled server and web app the app's version from tauri.conf.json, so the runtime,
// its CLI archive and the client all name the Gustaf release they ship in. CI runs this before
// building; the checked-in package versions stay at T3's 0.1.7.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const read = (file) => JSON.parse(NodeFS.readFileSync(NodePath.join(root, file), "utf8"));
const { version } = read("apps/shell/src-tauri/tauri.conf.json");
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected app version ${version}`);

for (const file of ["apps/server/package.json", "apps/web/package.json"]) {
  const manifest = read(file);
  manifest.version = version;
  NodeFS.writeFileSync(NodePath.join(root, file), `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`Stamped ${version} into the server and web packages.`);
