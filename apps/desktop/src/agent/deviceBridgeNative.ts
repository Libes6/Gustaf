// Connects deviceBridge.ts to the app's local bridge in Rust (src-tauri/src/device_bridge.rs): starts it on first use,
// registers per-chat tokens, answers its requests, and hands the agent adapters the environment for `gustaf-device`.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logFinish, logStart } from "./actionLogStore";
import { createDeviceBridge, type BridgeRequest, type BridgeTurn } from "./deviceBridge";
import { loadDeviceSettings } from "./deviceSettingsStore";

/** What an agent CLI process needs to run `gustaf-device`. */
export type DeviceCliEnv = {
  /** GUSTAF_DEVICE_URL and GUSTAF_DEVICE_TOKEN. */
  env: Record<string, string>;
  /** Folder with the `gustaf-device` launcher: prepended to the process PATH. */
  binDir: string;
};

const bridge = createDeviceBridge({
  settings: loadDeviceSettings,
  audit: (tool, summary) => {
    const id = logStart({ tool, summary });
    return (status, detail) => logFinish(id, status, detail);
  },
});

let started: Promise<{ url: string; binDir: string } | null> | undefined;

function start() {
  started ??= (async () => {
    try {
      const info = await invoke<{ url: string; binDir: string }>("device_bridge_prepare");
      await listen<BridgeRequest>("device-bridge-request", (e) => {
        const req = e.payload;
        void bridge
          .handle(req)
          .catch((err) => ({ ok: false, text: String(err?.message ?? err) }))
          .then((r) =>
            invoke("device_bridge_reply", { id: req.id, ok: r.ok, text: r.text, image: "image" in r ? r.image : null }),
          )
          .catch(() => {});
      });
      return info;
    } catch {
      // Windows, or a build without the bridge: CLI agents get no device command.
      started = undefined;
      return null;
    }
  })();
  return started;
}

export type DeviceCliHandle = DeviceCliEnv & { end: () => void };

/** Makes `gustaf-device` available to the chat's agent CLI for the length of this run; null when the bridge is unavailable. */
export async function startDeviceCli(chatId: number, turn: BridgeTurn): Promise<DeviceCliHandle | null> {
  const info = await start();
  if (!info) return null;
  const token = bridge.tokenFor(chatId);
  try {
    await invoke("device_bridge_register", { token });
  } catch {
    return null;
  }
  return {
    env: { GUSTAF_DEVICE_URL: info.url, GUSTAF_DEVICE_TOKEN: token },
    binDir: info.binDir,
    end: bridge.beginTurn(chatId, turn),
  };
}
