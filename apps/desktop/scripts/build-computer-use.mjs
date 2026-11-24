import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The Swift compiler targets the actual host; this script has no Effect runtime.
const hostArch = process.arch;
// oxlint-disable-next-line t3code/no-global-process-runtime -- ScreenCaptureKit and CGEvent exist only in the macOS SDK.
const hostPlatform = process.platform;

const { values } = NodeUtil.parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: hostArch } },
});
// Packaging passes --output and must not ship without the helper; dev builds only lose the feature.
const required = values.output !== undefined;

if (hostPlatform !== "darwin") {
  if (required) throw new Error("The computer-use helper can only be built on macOS.");
} else {
  const targets = { arm64: ["arm64"], x64: ["x86_64"], universal: ["arm64", "x86_64"] }[
    values.arch
  ];
  if (targets === undefined) throw new Error(`Unsupported macOS architecture: ${values.arch}`);
  const root = NodeURL.fileURLToPath(new URL("../../../native/computer-use/", import.meta.url));
  const source = NodePath.resolve(root, "ComputerUse.swift");
  const output =
    values.output ?? NodePath.resolve(root, "build", values.arch, "gustaf-computer-use");
  let current = false;
  try {
    current =
      NodeFS.statSync(output).mtimeMs >=
      Math.max(
        NodeFS.statSync(source).mtimeMs,
        NodeFS.statSync(NodeURL.fileURLToPath(import.meta.url)).mtimeMs,
      );
  } catch {}
  if (!current) {
    NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    const slices = targets.map((target) => `${temporary}.${target}`);
    try {
      targets.forEach((target, index) =>
        NodeChildProcess.execFileSync(
          "xcrun",
          [
            "swiftc",
            "-O",
            "-swift-version",
            "5",
            // Capture checks for macOS 14 at run time; older systems get an explicit error.
            "-target",
            `${target}-apple-macos12.0`,
            source,
            "-o",
            slices[index],
          ],
          { stdio: "inherit" },
        ),
      );
      NodeChildProcess.execFileSync("xcrun", ["lipo", "-create", ...slices, "-output", temporary], {
        stdio: "inherit",
      });
      NodeFS.renameSync(temporary, output);
    } catch (cause) {
      if (required) throw new Error("Building the computer-use helper requires Xcode.", { cause });
      console.warn(
        "Skipping the computer-use helper (needs Xcode); agents cannot control this Mac in this build.",
      );
    } finally {
      for (const file of [temporary, ...slices]) NodeFS.rmSync(file, { force: true });
    }
  }
}
