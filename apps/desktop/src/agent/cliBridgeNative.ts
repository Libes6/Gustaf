// Connects the app-side bridges (deviceBridge.ts for `gustaf-device`, agentBridge.ts for `gustaf-agent`) to the app's local
// bridge in Rust (src-tauri/src/device_bridge.rs): starts it on first use, registers per-chat tokens, routes its requests
// by command, and hands the agent adapters the environment for the commands. One token and one environment serve both.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logFinish, logStart } from "./actionLogStore";
import { createAgentBridge, type AgentTurn } from "./agentBridge";
import { createTokenRegistry, type BridgeReply, type BridgeRequest } from "./bridgeTokens";
import { createDeviceBridge, type BridgeTurn } from "./deviceBridge";
import { loadDeviceSettings } from "./deviceSettingsStore";

/** What an agent CLI process needs to run the bridge commands. */
export type CliBridgeEnv = {
  /** GUSTAF_BRIDGE_URL and GUSTAF_BRIDGE_TOKEN. */
  env: Record<string, string>;
  /** Folder with the `gustaf-device` and `gustaf-agent` launchers: prepended to the process PATH. */
  binDir: string;
};
/** Kept for the device command's callers. */
export type DeviceCliEnv = CliBridgeEnv;

const tokens = createTokenRegistry();
const audit = (tool: string, summary: string) => {
  const id = logStart({ tool, summary });
  return (status: "success" | "error" | "declined" | "cancelled", detail?: string) => logFinish(id, status, detail);
};
const deviceBridge = createDeviceBridge({ settings: loadDeviceSettings, audit, tokens });
const agentBridge = createAgentBridge({ audit, tokens });

const handlers: Record<string, (req: BridgeRequest) => Promise<BridgeReply>> = {
  device: (req) => deviceBridge.handle(req),
  agent: (req) => agentBridge.handle(req),
};

let started: Promise<{ baseUrl: string; binDir: string } | null> | undefined;

function start() {
  started ??= (async () => {
    try {
      const info = await invoke<{ baseUrl: string; binDir: string }>("device_bridge_prepare");
      await listen<BridgeRequest>("device-bridge-request", (e) => {
        const req = e.payload;
        const handle = handlers[req.command ?? "device"];
        void (handle ? handle(req) : Promise.resolve<BridgeReply>({ ok: false, text: "Unknown command." }))
          .catch((err): BridgeReply => ({ ok: false, text: String(err?.message ?? err) }))
          .then((r) =>
            invoke("device_bridge_reply", { id: req.id, ok: r.ok, text: r.text, image: "image" in r ? r.image : null }),
          )
          .catch(() => {});
      });
      return info;
    } catch {
      // Windows, or a build without the bridge: CLI agents get no commands.
      started = undefined;
      return null;
    }
  })();
  return started;
}

export type CliBridgeHandle = CliBridgeEnv & { end: () => void };
export type DeviceCliHandle = CliBridgeHandle;
export type AgentCliHandle = CliBridgeHandle;

/** Starts the bridge, registers the chat's token and returns the environment; null when the bridge is unavailable. */
async function prepare(chatId: number): Promise<CliBridgeEnv | null> {
  const info = await start();
  if (!info) return null;
  const token = tokens.tokenFor(chatId);
  try {
    await invoke("device_bridge_register", { token });
  } catch {
    return null;
  }
  return { env: { GUSTAF_BRIDGE_URL: info.baseUrl, GUSTAF_BRIDGE_TOKEN: token }, binDir: info.binDir };
}

/** Makes `gustaf-device` available to the chat's agent CLI for the length of this run; null when the bridge is unavailable. */
export async function startDeviceCli(chatId: number, turn: BridgeTurn): Promise<DeviceCliHandle | null> {
  const base = await prepare(chatId);
  return base && { ...base, end: deviceBridge.beginTurn(chatId, turn) };
}

/** Makes `gustaf-agent` available to the chat's agent CLI for the length of this run (its tasks stop when `end` runs). */
export async function startAgentCli(chatId: number, turn: AgentTurn): Promise<AgentCliHandle | null> {
  const base = await prepare(chatId);
  return base && { ...base, end: agentBridge.beginTurn(chatId, turn) };
}
