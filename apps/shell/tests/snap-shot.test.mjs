import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

NodeTest.test(
  "native snapshot protocol, permission and selection fixtures never capture real windows",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- This subprocess fixture requires the macOS host Swift compiler.
  { skip: NodeOS.platform() !== "darwin" },
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-snapshot-test-"));
    try {
      const executable = NodePath.join(directory, "snapshot");
      NodeChildProcess.execFileSync("xcrun", [
        "swiftc",
        NodeURL.fileURLToPath(new URL("../src-tauri/native/SnapShot.swift", import.meta.url)),
        "-o",
        executable,
      ]);
      const output = NodeChildProcess.execFileSync(executable, ["--self-test"], {
        encoding: "utf8",
      });
      NodeAssert.match(output, /SnapShot fixtures:.*passed/);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);
