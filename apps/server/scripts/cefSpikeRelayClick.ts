// Stage 0 CEF spike (apps/shell/cef-spike): started by the spike in the server's place, on the
// same two pipes. Drives the shell's Chromium tab through the real DesktopBrowserChannel relay
// with Playwright, the way ServerBrowser's `connectDesktopPage` does. Lives here, not beside the
// spike, because the relay and its dependencies resolve from this package.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { chromium } from "playwright-core";

import * as ServerConfig from "../src/config.ts";
import * as DesktopBrowserChannel from "../src/preview/DesktopBrowserChannel.ts";

const key = { threadId: "spike-thread", tabId: "tab-1" };
const fd = (name: string) => Number(process.env[name]);

const PAGE = `<!doctype html><title>relay click</title>
<body style="font: 20px sans-serif; padding: 40px">
<button id="go" style="font-size: 24px; padding: 12px 24px">Click me</button>
<p id="out">not clicked</p>
<script>
  document.getElementById("go").addEventListener("click", (event) => {
    document.getElementById("out").textContent =
      "clicked trusted=" + event.isTrusted + " at " + event.clientX + "," + event.clientY;
  });
</script>`;

const drive = async (endpoint: string) => {
  const started = performance.now();
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  const page = browser.contexts().flatMap((context) => context.pages())[0];
  if (!page) throw new Error("The desktop tab has no page.");
  const connectMs = Math.round(performance.now() - started);
  const first = { url: page.url(), title: await page.title() };
  await page.setContent(PAGE);
  await page.click("#go");
  const clicked = await page.textContent("#out");
  const screenshot = process.env["CEF_SPIKE_SCREENSHOT"];
  if (screenshot) NodeFS.writeFileSync(screenshot, await page.screenshot());
  await page.goto("https://example.com/");
  const navigated = { url: page.url(), title: await page.title() };
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    userAgent: navigator.userAgent,
  }));
  await browser.close();
  return { connectMs, first, clicked, navigated, viewport };
};

const program = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* Effect.gen(function* () {
    const channel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
    if (!(yield* channel.awaitAttached(key, "90 seconds")))
      return yield* Effect.die("The shell never attached its tab.");
    const endpoint = yield* channel.endpoint(key);
    return yield* Effect.promise(() => drive(endpoint));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      DesktopBrowserChannel.layer.pipe(
        Layer.provide(
          ServerConfig.layer({
            ...config,
            desktopBrowserFd: fd("GUSTAF_DESKTOP_BROWSER_FD"),
            desktopBrowserControlFd: fd("GUSTAF_DESKTOP_BROWSER_CONTROL_FD"),
          }),
        ),
      ),
    ),
  );
}).pipe(
  Effect.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "cef-spike-relay-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
);

Effect.runPromise(program).then(
  (result) => {
    console.log(`[driver] ${JSON.stringify(result)}`);
    process.exit(0);
  },
  (cause) => {
    console.error("[driver] failed", cause);
    process.exit(1);
  },
);
