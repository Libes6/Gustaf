// Stages Chromium for the macOS bundle (tauri.macos.conf.json runs it before bundling): the CEF
// framework the `cef` crate downloaded, and the helper app Chromium starts its child processes
// from. Both land in src-tauri/target/browser, where the bundle config picks them up.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

if (NodeProcess.platform !== "darwin") NodeProcess.exit(0);

const shell = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const target = NodeProcess.env.CARGO_TARGET_DIR ?? NodePath.join(shell, "src-tauri", "target");
const out = NodePath.join(target, "browser");
const helperName = "Gustaf Browser Helper";
const framework = "Chromium Embedded Framework.framework";

const run = (command, args, options = {}) => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`);
};

run(
  "cargo",
  ["build", "--release", "--manifest-path", NodePath.join(shell, "browser-helper", "Cargo.toml")],
  { env: { ...NodeProcess.env, CARGO_TARGET_DIR: target } },
);

// cef-dll-sys unpacks CEF into its build output, or uses CEF_PATH when one is set.
const findCef = () => {
  if (NodeProcess.env.CEF_PATH) {
    const versions = NodeFS.readdirSync(NodeProcess.env.CEF_PATH);
    for (const version of versions) {
      const dir = NodePath.join(NodeProcess.env.CEF_PATH, version, "cef_macos_aarch64");
      if (NodeFS.existsSync(NodePath.join(dir, framework))) return dir;
    }
  }
  const build = NodePath.join(target, "release", "build");
  const candidates = NodeFS.readdirSync(build)
    .filter((name) => name.startsWith("cef-dll-sys-"))
    .map((name) => NodePath.join(build, name, "out", "cef_macos_aarch64"))
    .filter((dir) => NodeFS.existsSync(NodePath.join(dir, framework)));
  if (candidates.length === 0) throw new Error("No CEF download found; build the shell first.");
  return candidates.sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
};
const cef = findCef();
const version = JSON.parse(NodeFS.readFileSync(NodePath.join(cef, "archive.json"), "utf8")).name;

NodeFS.rmSync(out, { recursive: true, force: true });
NodeFS.mkdirSync(out, { recursive: true });
NodeFS.cpSync(NodePath.join(cef, framework), NodePath.join(out, framework), {
  recursive: true,
  verbatimSymlinks: true,
});

const contents = NodePath.join(out, `${helperName}.app`, "Contents");
NodeFS.mkdirSync(NodePath.join(contents, "MacOS"), { recursive: true });
NodeFS.copyFileSync(
  NodePath.join(target, "release", "gustaf-browser-helper"),
  NodePath.join(contents, "MacOS", helperName),
);
NodeFS.chmodSync(NodePath.join(contents, "MacOS", helperName), 0o755);
NodeFS.writeFileSync(
  NodePath.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>${helperName}</string>
  <key>CFBundleIdentifier</key><string>io.github.libes6.gustaf.browser-helper</string>
  <key>CFBundleName</key><string>${helperName}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>LSEnvironment</key><dict><key>MallocNanoZone</key><string>0</string></dict>
</dict>
</plist>
`,
);
// The bundler signs the framework; the helper is a plain file to it, so it is signed here.
run("codesign", ["--force", "--sign", "-", NodePath.join(out, `${helperName}.app`)]);
console.log(`Staged Chromium ${version} in ${out}`);
