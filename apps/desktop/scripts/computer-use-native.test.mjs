import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The helper is built for the actual macOS host.
const hostPlatform = process.platform;

// Only the --hold-lock mode runs here: it touches no screen, mouse or keyboard.
describe.skipIf(hostPlatform !== "darwin")("computer-use helper owner lock", () => {
  let directory;
  let executable;
  beforeAll(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-use-test-"));
    executable = NodePath.join(directory, "gustaf-computer-use");
    NodeChildProcess.execFileSync(process.execPath, [
      NodeURL.fileURLToPath(new URL("./build-computer-use.mjs", import.meta.url)),
      "--output",
      executable,
    ]);
  });
  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  const holder = (owner) => ({ pid: 7, app: "Gustaf", owner });

  /** Resolves with the helper's answer; the lock stays held until `release` closes its stdin. */
  const claim = (path, owner) =>
    new Promise((resolve, reject) => {
      const child = NodeChildProcess.spawn(executable, ["--hold-lock", path]);
      const exited = new Promise((done) => child.once("exit", done));
      let output = "";
      child.once("error", reject);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("\n")) return;
        resolve({
          answer: JSON.parse(output),
          release: () => {
            child.stdin.end();
            return exited;
          },
        });
      });
      child.stdin.write(`${JSON.stringify(holder(owner))}\n`);
    });

  it("refuses a second owner, names the holder, and frees the Mac when the holder lets go", async () => {
    const path = NodePath.join(directory, "nested", "owner.lock");
    const first = await claim(path, "Thread A");
    expect(first.answer).toEqual({ held: true });
    // Another process, as another Gustaf instance or an older build would be.
    const second = await claim(path, "Thread B");
    expect(second.answer).toEqual({ busy: holder("Thread A") });
    await second.release();
    await first.release();
    expect(NodeFS.readFileSync(path, "utf8")).toBe("");
    const third = await claim(path, "Thread B");
    expect(third.answer).toEqual({ held: true });
    await third.release();
  });

  it("does not let a record left by a crashed owner hold the Mac", async () => {
    const path = NodePath.join(directory, "crashed.lock");
    NodeFS.writeFileSync(path, JSON.stringify(holder("Crashed")));
    const fresh = await claim(path, "Fresh");
    expect(fresh.answer).toEqual({ held: true });
    expect(JSON.parse(NodeFS.readFileSync(path, "utf8"))).toEqual(holder("Fresh"));
    await fresh.release();
  });
});
