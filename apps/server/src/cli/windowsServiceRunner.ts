// @effect-diagnostics nodeBuiltinImport:off
// Standalone CLI boundary: keep the scheduled task alive for its child and propagate its exit code.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { readServiceEnvironment } from "../serviceLauncher.ts";

export async function runWindowsService(baseDir: string, logPath: string) {
  await NodeFSP.mkdir(NodePath.dirname(logPath), { recursive: true });
  const log = await NodeFSP.open(logPath, "a");
  try {
    const env = await readServiceEnvironment(baseDir);
    env.T3CODE_HOME = baseDir;
    env.T3_BOOT_SERVICE_UNIT = "windows-task";
    const child = NodeChildProcess.spawn(process.execPath, ["serve"], {
      env,
      windowsHide: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    process.exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } catch (cause) {
    await log.write(`${String(cause)}\n`);
    process.exitCode = 1;
  } finally {
    await log.close();
  }
}
