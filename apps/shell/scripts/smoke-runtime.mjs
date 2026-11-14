// Starts the bundled server the way the shell does and opens its web app in Chrome,
// signed in and bridged the way the shell's window is.
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

// The shell signs its window in itself and injects a bridge the page then relies on.
// A bridge that lacks one call the page makes while it starts leaves a blank window,
// so the second pass loads the page the way the shell does, with the real script.
const INIT_SCRIPT = NodeFS.readFileSync(
  NodePath.join(root, "apps/shell/src-tauri/src/bridge.rs"),
  "utf8",
)
  .split('const INIT_SCRIPT: &str = r#"')[1]
  .split('"#;')[0];
const PAIRING_FORM = /pair with this environment|сопрячь с этим окружением/i;

async function exchangeForBearer(origin, token) {
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Gustaf",
      client_device_type: "desktop",
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

/** What the shell's commands answer on a fresh install. */
function shellCommands(bearer) {
  const exposure = { mode: "local-only", endpointUrl: null, advertisedHost: null };
  return {
    local_environment_bearer_token: () => bearer,
    read_client_settings: () => null,
    write_client_settings: () => null,
    read_connection_catalog: () => null,
    write_connection_catalog: () => null,
    window_fullscreen_state: () => false,
    set_window_theme: () => null,
    reveal_window: () => null,
    server_exposure_state: () => exposure,
    advertised_endpoints: () => [],
    dropped_paths: () => [],
    client_config: () => ({
      announcements: [],
      update: { required: false, minimumVersion: null, message: null },
      flags: {},
    }),
    update_state: () => ({
      enabled: false,
      status: "disabled",
      channel: "latest",
      currentVersion: "0.0.0",
      hostArch: "arm64",
      appArch: "arm64",
      runningUnderArm64Translation: false,
      availableVersion: null,
      downloadedVersion: null,
      releaseNotes: [],
      omittedReleaseCount: 0,
      downloadPercent: null,
      checkedAt: null,
      message: "Automatic updates are not available in this build.",
      errorContext: null,
      canRetry: false,
    }),
  };
}

async function startAsShell(browser, pairingUrl) {
  const url = new URL(pairingUrl);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const bearer = await exchangeForBearer(url.origin, token);
  const commands = shellCommands(bearer);
  const unknownCommands = new Set();
  const page = await browser.newPage({ userAgent: "GustafShell/1" });
  const cspViolations = [];
  page.on("console", (message) => {
    if (/content.security.policy|violates.*directive|refused to/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });
  await page.exposeFunction("__gustafSmokeCspViolation", (violation) => {
    cspViolations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__gustafSmokeCspViolation(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));
  await page.exposeFunction("__gustafSmokeInvoke", (command) => {
    if (command in commands) return commands[command]();
    if (command.startsWith("plugin:")) return null;
    unknownCommands.add(command);
    throw new Error(`The smoke test has no answer for the command ${command}.`);
  });
  await page.addInitScript(() => {
    window.__TAURI_INTERNALS__ = { invoke: (command) => window.__gustafSmokeInvoke(command) };
  });
  const bootstraps = [
    {
      id: "primary",
      label: "This computer",
      httpBaseUrl: `${url.origin}/`,
      wsBaseUrl: `${url.origin.replace(/^http/, "ws")}/`,
      bootstrapToken: token,
    },
  ];
  await page.addInitScript(
    INIT_SCRIPT.replaceAll("__GUSTAF_VERSION__", '"0.0.0"')
      .replaceAll("__GUSTAF_BOOTSTRAPS__", JSON.stringify(bootstraps))
      .replaceAll("__GUSTAF_PLATFORM__", '"darwin"'),
  );
  const response = await page.goto(`${url.origin}/`);
  if (!response.headers()["content-security-policy"]?.includes("script-src 'self'")) {
    throw new Error("The shell HTML response has no enforced CSP.");
  }
  await page.waitForTimeout(SETTLE_MS);
  for (const route of ["/settings/appearance", "/settings/keybindings", "/"]) {
    await page.goto(`${url.origin}${route}`);
    await page.waitForTimeout(SETTLE_MS);
  }
  const text = await page.evaluate(() => document.body.innerText);
  const bridged = await page.evaluate(() => window.desktopBridge !== undefined);
  if (NodeProcess.env.GUSTAF_SMOKE_SCREENSHOT) {
    await page.screenshot({ path: NodeProcess.env.GUSTAF_SMOKE_SCREENSHOT });
  }
  const problems = [
    !bridged && "the shell bridge was not installed",
    text.trim() === "" && "the page is blank",
    text.toLowerCase().includes(BOOT_FAILURE) && "the page reports a start failure",
    PAIRING_FORM.test(text) && "the page asks to pair instead of signing in",
    pageErrors.length > 0 && "the page threw",
    cspViolations.length > 0 && `CSP violations: ${cspViolations.join("; ")}`,
    unknownCommands.size > 0 && `unanswered commands: ${[...unknownCommands].join(", ")}`,
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new Error(
      `The web app did not start inside the shell bridge: ${problems.join("; ")}.\n\nPage text:\n${text.slice(0, 2000)}\n\nPage errors:\n${pageErrors.join("\n")}`,
    );
  }
  console.log(
    `The web app started inside the shell bridge. First text: ${JSON.stringify(text.slice(0, 200))}`,
  );
}

// A server that is already running (a dev server) can stand in for the bundled one.
const externalPairingUrl = NodeProcess.env.GUSTAF_SMOKE_PAIRING_URL;
const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "gustaf-smoke-"));
const server = externalPairingUrl
  ? null
  : NodeChildProcess.spawn(
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
  const pairingUrl =
    externalPairingUrl ??
    (await new Promise((resolve, reject) => {
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
    }));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  await startAsShell(browser, pairingUrl);
} finally {
  await browser?.close();
  server?.kill();
  NodeFS.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5 });
}
