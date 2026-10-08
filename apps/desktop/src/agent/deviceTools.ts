// Runs the device_* tools (definitions and validation: deviceCore.ts) against a DeviceDriver. The driver comes from
// `getDeviceDriver()` (src/device/driverSeam.ts) unless a test passes one. Keeps, per chat, the device the agent opened,
// the last snapshot of each device (to tell a stale ref from a good one) and which devices the user already allowed.
// Failures are thrown as plain Errors: the agent loop turns them into tool errors for the model.
import { DeviceError, type DeviceDriver, type DeviceInfo } from "../device/types";
import { getDeviceDriver } from "../device/driverSeam";
import { clearAgentDevice, setAgentDevice } from "../device/agentActivity";
import { renderMap, type UiMap } from "../device/uiMap";
import {
  STALE_REF_HINT,
  approvalText,
  deviceLabel,
  formatActionOutput,
  isDestructive,
  parseDeviceCall,
  pointError,
  renderDeviceList,
  type DeviceCall,
} from "./deviceCore";

export { DEVICE_TOOLS, isDeviceTool } from "./deviceCore";

/** What the user is asked. `destructive` cards offer no "always" option and are asked even when first-use asking is off. */
export type DeviceApprovalRequest = {
  kind: "device";
  device: string;
  text: string;
  destructive?: boolean;
  agent?: string;
};

/** The user answered "no" to an approval card. */
export class DeviceDeclined extends Error {}

export type DeviceToolContext = {
  /** The chat the agent runs in; device memory and approvals are kept per chat. */
  chatId?: number;
  signal: AbortSignal;
  /** Ask the first time a device is used in this chat (Settings > Devices). */
  askFirst: boolean;
  approve: (req: DeviceApprovalRequest) => Promise<boolean | "task">;
  agent?: string;
  /** Tests: a driver to use instead of the installed one. */
  driver?: () => DeviceDriver;
  /** Tests: waits between boot checks. */
  sleep?: (ms: number) => Promise<void>;
};

export type DeviceToolResult = { output: string; image?: string };

const MAX_OUTPUT = 20_000;
const BOOT_WAIT_MS = 90_000;

type ChatState = {
  current?: string;
  approved: Set<string>;
  maps: Map<string, UiMap>;
};
const chats = new Map<number, ChatState>();
const stateOf = (chatId = 0): ChatState => {
  let s = chats.get(chatId);
  if (!s) chats.set(chatId, (s = { approved: new Set(), maps: new Map() }));
  return s;
};

/** The device the agent last opened in this chat. */
export const currentDeviceOf = (chatId?: number) => chats.get(chatId ?? 0)?.current;
/** Forgets everything remembered for a chat (or for all chats): the chosen device, snapshots and approvals. */
export function resetDeviceMemory(chatId?: number) {
  if (chatId === undefined) chats.clear();
  else chats.delete(chatId);
}

/** The error the model sees for a stale ref; the driver's own error is kept as `cause`. */
const staleRefError = (cause: unknown) => Object.assign(new Error(STALE_REF_HINT), { cause });
const abortError = () => new DOMException("Aborted", "AbortError");

/** Settles with `p`, or rejects as soon as the signal aborts (the driver call itself cannot be cancelled and finishes on its own). */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function pick(devices: readonly DeviceInfo[], query: string): DeviceInfo {
  const q = query.trim().toLowerCase();
  const byId = devices.find((d) => d.id.toLowerCase() === q);
  if (byId) return byId;
  const exact = devices.filter((d) => d.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const part = exact.length ? exact : devices.filter((d) => d.name.toLowerCase().includes(q));
  if (part.length === 1) return part[0];
  if (part.length > 1)
    throw new Error(`"${query}" matches several devices; pass the id of one:\n${renderDeviceList(part)}`);
  throw new Error(`No device matches "${query}". Devices:\n${renderDeviceList(devices)}`);
}

const clipOutput = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (output cut)` : s);

/** Runs one device tool call. Throws on invalid arguments, a missing driver or device, a driver failure, or a declined approval. */
export async function runDeviceTool(
  toolName: string,
  args: unknown,
  ctx: DeviceToolContext,
): Promise<DeviceToolResult> {
  const parsed = parseDeviceCall(toolName, args);
  if (!parsed.ok) throw new Error(parsed.error);
  const call = parsed.call;
  const driver = (ctx.driver ?? getDeviceDriver)();
  const st = stateOf(ctx.chatId);
  const guard = <T>(p: Promise<T>) => raceAbort(p, ctx.signal);
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (ctx.signal.aborted) throw abortError();

  if (call.tool === "device_list") {
    const devices = await guard(driver.list());
    return { output: renderDeviceList(devices, st.current) };
  }

  const info = await resolve(call, driver, st, guard);
  await ensureAllowed(call, info, st, ctx);
  setAgentDevice({ chatId: ctx.chatId ?? 0, deviceId: info.id, name: deviceLabel(info), tool: call.tool });
  const label = deviceLabel(info);

  try {
    switch (call.tool) {
      case "device_open": {
        if (info.state !== "booted") {
          if (info.state !== "booting") await guard(driver.boot(info.id));
          await waitBooted(driver, info.id, guard, sleep);
        }
        st.current = info.id;
        return {
          output: `Using ${label} (id ${info.id}). Call device_snapshot to see the screen.`,
        };
      }
      case "device_snapshot": {
        const map = await guard(driver.snapshot(info.id));
        st.maps.set(info.id, map);
        const out: DeviceToolResult = { output: clipOutput(`${label}\n${renderMap(map)}`) };
        if (call.screenshot) {
          const frame = await guard(driver.frame(info.id));
          if (frame.mime === "image/png") out.image = frame.data;
          else out.output += "\n(The screenshot could not be attached: the device returned a JPEG.)";
        }
        return out;
      }
      case "device_close": {
        if (call.shutdown) await guard(driver.shutdown(info.id));
        else await guard(driver.release(info.id));
        st.maps.delete(info.id);
        if (st.current === info.id) st.current = undefined;
        clearAgentDevice(ctx.chatId ?? 0);
        return { output: call.shutdown ? `${label} was powered off.` : `Closed the automation session with ${label}.` };
      }
      default: {
        await checkTarget(call, info.id, st, driver, guard);
        const r = await guard(act(call, info.id, driver));
        return { output: clipOutput(formatActionOutput(r)) };
      }
    }
  } catch (e) {
    if (e instanceof DeviceError && e.code === "stale-ref") {
      st.maps.delete(info.id);
      throw staleRefError(e);
    }
    throw e;
  }
}

/** The device a call is about: the one named, else the chat's current one, else the only booted one. */
async function resolve(
  call: DeviceCall,
  driver: DeviceDriver,
  st: ChatState,
  guard: <T>(p: Promise<T>) => Promise<T>,
): Promise<DeviceInfo> {
  const devices = await guard(driver.list());
  if (call.device) return pick(devices, call.device);
  if (call.tool !== "device_open") {
    const current = devices.find((d) => d.id === st.current);
    if (current) return current;
    st.current = undefined;
    const booted = devices.filter((d) => d.state === "booted");
    if (booted.length === 1) return ((st.current = booted[0].id), booted[0]);
    throw new Error(`No device is selected. Call device_open with one of these:\n${renderDeviceList(devices)}`);
  }
  const booted = devices.filter((d) => d.state === "booted");
  if (booted.length === 1) return booted[0];
  throw new Error(`Say which device to open (pass \`device\`):\n${renderDeviceList(devices)}`);
}

async function ensureAllowed(call: DeviceCall, info: DeviceInfo, st: ChatState, ctx: DeviceToolContext) {
  const destructive = isDestructive(call);
  if (!destructive && (!ctx.askFirst || st.approved.has(info.id))) return;
  const answer = await raceAbort(
    ctx.approve({
      kind: "device",
      device: deviceLabel(info),
      text: approvalText(call, info),
      ...(destructive ? { destructive: true } : {}),
      ...(ctx.agent ? { agent: ctx.agent } : {}),
    }),
    ctx.signal,
  );
  if (!answer) throw new DeviceDeclined("User declined device access.");
  if (!destructive) st.approved.add(info.id);
}

async function waitBooted(
  driver: DeviceDriver,
  id: string,
  guard: <T>(p: Promise<T>) => Promise<T>,
  sleep: (ms: number) => Promise<void>,
) {
  for (let waited = 0; ; waited += 1000) {
    const d = (await guard(driver.list())).find((x) => x.id === id);
    if (d?.state === "booted") return;
    if (!d) throw new Error("The device disappeared while starting.");
    if (waited >= BOOT_WAIT_MS) throw new Error("The device did not finish booting within 90 seconds.");
    await guard(sleep(1000));
  }
}

/** Refs must come from the latest snapshot of this device; points must lie on its screen. */
async function checkTarget(
  call: DeviceCall,
  id: string,
  st: ChatState,
  driver: DeviceDriver,
  guard: <T>(p: Promise<T>) => Promise<T>,
) {
  const map = st.maps.get(id);
  if ("target" in call && "ref" in call.target) {
    const ref = call.target.ref;
    if (!map)
      throw new Error(
        `No snapshot of this screen yet: call device_snapshot first, then use its refs (@${ref} is unknown).`,
      );
    if (!map.nodes.some((n) => n.ref === ref))
      throw new Error(`@${ref} is not in the latest snapshot. ${STALE_REF_HINT}`);
    return;
  }
  const hasPoint = call.tool === "device_swipe" || ("target" in call && "x" in call.target);
  if (!hasPoint) return;
  const screen = map?.viewport.width ? map.viewport : (await guard(driver.frame(id))).points;
  const bad = pointError(call, screen);
  if (bad) throw new Error(bad);
}

function act(call: DeviceCall, id: string, d: DeviceDriver) {
  switch (call.tool) {
    case "device_tap":
      return d.tap(id, call.target);
    case "device_long_press":
      return d.longPress(id, call.target, call.ms);
    case "device_swipe":
      return d.swipe(id, call.from, call.to, call.ms);
    case "device_type":
      return d.type(id, call.text);
    case "device_fill":
      return d.fill(id, call.target, call.text);
    case "device_press":
      return d.press(id, call.key);
    case "device_scroll":
      return d.scroll(id, call.direction, call.amount);
    case "device_open_app":
      return d.openApp(id, call.app);
    default:
      throw new Error(`Not an action: ${call.tool}`);
  }
}
