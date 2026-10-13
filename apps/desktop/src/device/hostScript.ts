// The long-lived helper host: a small Node script that keeps ONE `agent-device` client alive and answers JSON lines on
// stdin/stdout, instead of starting `node agent-device.mjs` for every call. It is written next to the helper package
// (`<appDataDir>/device-helper/gustaf-host.mjs`) and started through `helperHost.ts` / providers/processHost.ts.
//
// Protocol (one JSON object per line):
//   host -> us   {"ready":true,"version":"0.21.23"}                       once, after the helper client loaded
//   us -> host   {"id":7,"argv":["press","@e7","--settle","--session","gustaf-X","--udid","X","--platform","ios","--json"]}
//   host -> us   {"id":7,"reply":{"success":true,"data":{...}}}           same shape as the CLI's `--json` output
//                {"id":7,"reply":{"success":false,"error":{"code","message","hint","details"}}}
//                {"id":7,"unsupported":true}                             a command the host does not map: use the CLI
// The argv is exactly what the CLI would get, so the driver builds one command line for both paths.
// The script never uses template literals or backticks: it is embedded in a TS template string.

export const HOST_SCRIPT = String.raw`import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const pkgDir = process.argv[2];
const clientModule = process.env.GUSTAF_HOST_CLIENT || pathToFileURL(join(pkgDir, "dist", "src", "index.js")).href;
const { createAgentDeviceClient } = await import(clientModule);
const client = createAgentDeviceClient({});
let version = "";
try { version = JSON.parse((await import("node:fs")).readFileSync(join(pkgDir, "package.json"), "utf8")).version; } catch {}

const VALUE_FLAGS = new Set(["--session", "--udid", "--serial", "--platform"]);
function parse(argv) {
  const o = { rest: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) o[a.slice(2)] = argv[++i];
    else if (a === "--json") continue;
    else if (a === "--settle" || a === "--foreground" || a === "--system" || a === "-i") o.flags.add(a);
    else o.rest.push(a);
  }
  return o;
}
const num = (s) => Number(s);
function target(items) {
  if (items[0] && items[0][0] === "@") return { t: { ref: items[0] }, used: 1 };
  return { t: { x: num(items[0]), y: num(items[1]) }, used: 2 };
}

async function dispatch(p) {
  const [cmd, ...a] = p.rest;
  const base = { session: p.session, platform: p.platform };
  if (p.udid) base.udid = p.udid;
  if (p.serial) base.serial = p.serial;
  const settle = p.flags.has("--settle") ? { settle: true } : {};
  switch (cmd) {
    case "open": return client.apps.open({ ...base, app: a[0] });
    case "snapshot": return client.capture.snapshot({ ...base, interactiveOnly: true });
    case "press": return client.interactions.press({ ...base, ...target(a).t, ...settle });
    case "longpress": {
      const { t, used } = target(a);
      return client.interactions.longPress({ ...base, ...t, ...(a[used] ? { durationMs: num(a[used]) } : {}), ...settle });
    }
    case "swipe": return client.interactions.swipe({ ...base, from: { x: num(a[0]), y: num(a[1]) }, to: { x: num(a[2]), y: num(a[3]) } });
    case "gesture":
      if (a[0] !== "pan") return undefined;
      return client.interactions.pan({ ...base, x: num(a[1]), y: num(a[2]), dx: num(a[3]), dy: num(a[4]), ...(a[5] ? { durationMs: num(a[5]) } : {}) });
    case "type": return client.interactions.type({ ...base, text: a[0] });
    case "fill": { const { t, used } = target(a); return client.interactions.fill({ ...base, ...t, text: a[used], ...settle }); }
    case "scroll": return client.interactions.scroll({ ...base, direction: a[0], ...(a[1] ? { amount: num(a[1]) } : {}), ...settle });
    case "home": return client.command.home(base);
    case "back": return client.command.back({ ...base, ...(p.flags.has("--system") ? { mode: "system" } : {}), ...settle });
    case "app-switcher": return client.command.appSwitcher(base);
    case "keyboard": return a[0] === "enter" ? client.command.keyboard({ ...base, action: "enter" }) : undefined;
    case "close": return client.sessions.close(base);
    default: return undefined;
  }
}

function failure(e) {
  const d = (e && e.details) || {};
  return { success: false, error: { code: e && e.code, message: (e && e.message) || String(e), hint: d.hint, details: { reason: d.reason } } };
}

const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (!req || typeof req.id !== "number" || !Array.isArray(req.argv)) return;
  try {
    const data = await dispatch(parse(req.argv));
    if (data === undefined) out({ id: req.id, unsupported: true });
    else out({ id: req.id, reply: { success: true, data } });
  } catch (e) {
    out({ id: req.id, reply: failure(e) });
  }
});
rl.on("close", () => process.exit(0));
out({ ready: true, version });
`;
