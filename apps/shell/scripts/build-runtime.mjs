import * as NodeProcess from "node:process";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const serverDir = NodePath.join(root, "apps/server");
const shellDir = NodePath.join(root, "apps/shell/src-tauri");
const { version } = JSON.parse(
  NodeFS.readFileSync(NodePath.join(serverDir, "package.json"), "utf8"),
);
const platform = { darwin: "mac", linux: "linux", win32: "win" }[NodeProcess.platform];
const architecture = NodeProcess.arch;
const windows = platform === "win";
const suffix = windows ? ".exe" : "";
const platformKey = `${NodeProcess.platform}-${architecture}`;
const stem = `t3-${version}-${platformKey}`;
const stage = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-runtime-"));

const env = {
  ...process.env,
  PATH: `${NodePath.join(root, "node_modules/.bin")}${NodePath.delimiter}${process.env.PATH}`,
};
const run = (command, args, cwd = root) =>
  NodeChildProcess.execFileSync(command, args, { cwd, env, stdio: "inherit" });
const node = (args) => run(process.execPath, args);

try {
  node(["node_modules/vite-plus/bin/vp", "run", "--filter", "t3", "build"]);
  node(["apps/server/scripts/cli.ts", "build-exe"]);
  // A fixed target directory, so CI can cache it; a temporary one recompiles the monitor every run.
  const monitorTarget = NodePath.join(root, "native/resource-monitor/target");
  const monitorDir = NodePath.join(stage, "resource-monitor", platformKey);
  const monitor = `t3-resource-monitor${suffix}`;
  run("cargo", [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    "native/resource-monitor/Cargo.toml",
    "--target-dir",
    monitorTarget,
  ]);
  NodeFS.mkdirSync(monitorDir, { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(monitorTarget, "release", monitor),
    NodePath.join(monitorDir, monitor),
  );
  node([
    "scripts/build-cli-archive.ts",
    "--platform",
    platform,
    "--arch",
    architecture,
    "--version",
    version,
    "--resource-monitor-dir",
    NodePath.dirname(monitorDir),
    "--output-dir",
    stage,
  ]);
  const archive = NodePath.join(stage, `${stem}.${windows ? "zip" : "tar.gz"}`);
  node(["scripts/smoke-cli-archive.ts", "--archive", archive, "--expect-version", version]);

  const tar = windows ? NodePath.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  run(tar, ["-xf", archive, "-C", stage]);
  const extracted = NodePath.join(stage, stem);
  if (platform === "linux") {
    // linuxdeploy runs ldd on every ELF file. Runtime packages sometimes
    // ship both libc variants, even though this installer targets glibc.
    const modules = NodePath.join(extracted, "node_modules");
    const entries = NodeFS.readdirSync(modules, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (/(?:^|[-_])musl(?:$|[-_.])/.test(entry.name)) {
        NodeFS.rmSync(NodePath.join(entry.parentPath, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }
  const runtime = NodePath.join(shellDir, "runtime");
  NodeFS.rmSync(runtime, { recursive: true, force: true });
  NodeFS.cpSync(extracted, runtime, { recursive: true, verbatimSymlinks: true });
} finally {
  NodeFS.rmSync(stage, { recursive: true, force: true });
}
