// Mimics the server's screencast policy for one tab: 1x CSS-pixel JPEG q50, one frame in flight,
// ack 50 ms after arrival. Prints phase marks so the runner can sum Chrome's CPU time per phase.
import { chromium } from "/Users/maksimkulakov/pet/m-code-live-wallpapers/node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core/index.mjs";

const [executable, url, gpuMode] = process.argv.slice(2);
const settle = Number(process.env.SPIKE_SETTLE_SECS ?? 5) * 1000;
const idle = Number(process.env.SPIKE_IDLE_SECS ?? 20) * 1000;
const scroll = Number(process.env.SPIKE_SCROLL_SECS ?? 20) * 1000;
const width = 700, height = 850;
const SCROLL_START = `window.__spikeScroll = setInterval(() => {
  const max = document.documentElement.scrollHeight - innerHeight;
  if (window.__dir === undefined) window.__dir = 1;
  if (scrollY >= max - 2) window.__dir = -1; else if (scrollY <= 0) window.__dir = 1;
  scrollBy(0, 40 * window.__dir); }, 16);`;

const mark = (label) => console.log(`[spike] ${label} ${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: executable,
  args: [
    gpuMode === "metal" ? "--use-angle=metal" : "--disable-gpu",
    "--force-device-scale-factor=2",
    "--disable-blink-features=AutomationControlled",
  ],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
const cdp = await page.context().newCDPSession(page);
let frames = 0, bytes = 0;
cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
  frames += 1;
  bytes += data.length * 0.75;
  setTimeout(() => cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {}), 50);
});
await page.goto(url, { waitUntil: "load", timeout: 60_000 });
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
mark("loaded");
await sleep(settle);
const phase = async (name, ms) => {
  frames = 0; bytes = 0;
  mark(`${name}-start`);
  await sleep(ms);
  mark(`${name}-end`);
  console.log(`[spike] frames ${name} ${(frames / (ms / 1000)).toFixed(1)}fps ${(bytes / 1024 / Math.max(frames, 1)).toFixed(0)}KB/frame`);
};
await phase("idle", idle);
await page.evaluate(SCROLL_START);
await phase("scroll", scroll);
await sleep(3000);
await browser.close();
