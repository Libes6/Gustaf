// Starts the bundled server the way the shell does and opens its web app in Chrome.
// Releases 0.8.0 and 0.8.1 shipped a client that died while its modules loaded;
// no build step or unit test sees that, only a browser does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

const root = NodeURL.fileURLToPath(new URL("../../..", import.meta.url));
const runtime = NodePath.join(root, "apps/shell/src-tauri/runtime");
const executable = NodePath.join(runtime, NodeProcess.platform === "win32" ? "t3.exe" : "t3");
// The server package already depends on playwright-core.
const { chromium } = NodeModule.createRequire(NodePath.join(root, "apps/server/package.json"))(
  "playwright-core",
);

const BOOT_FAILURE = "failed to start";
const START_TIMEOUT_MS = 120_000;
const SETTLE_MS = 8_000;

const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-smoke-"));
const server = NodeChildProcess.spawn(
  executable,
  [
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--no-browser",
    "--no-auto-bootstrap-project-from-cwd",
    "--base-dir",
    baseDir,
  ],
  { cwd: runtime, stdio: ["ignore", "pipe", "inherit"] },
);

let browser;
try {
  const pairingUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The server printed no pairing URL.")),
      START_TIMEOUT_MS,
    );
    server.once("exit", (code) => reject(new Error(`The server exited with code ${code}.`)));
    NodeReadline.createInterface({ input: server.stdout }).on("line", (line) => {
      const match = /pairingUrl:\s*(http:\/\/[^\s,"']+)/.exec(line);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    });
  });

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto(pairingUrl);
  await page.waitForTimeout(SETTLE_MS);
  const text = await page.evaluate(() => document.body.innerText);

  if (text.toLowerCase().includes(BOOT_FAILURE) || pageErrors.length > 0 || text.trim() === "") {
    throw new Error(
      `The web app did not start.\n\nPage text:\n${text.slice(0, 2000)}\n\nPage errors:\n${pageErrors.join("\n")}`,
    );
  }
  console.log(`The web app started. First text on the page: ${JSON.stringify(text.slice(0, 200))}`);
} finally {
  await browser?.close();
  server.kill();
  NodeFS.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5 });
}
