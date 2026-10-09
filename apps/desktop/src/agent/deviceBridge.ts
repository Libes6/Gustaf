// App side of the `gustaf-device` command (docs/features/devices.md, "Agents"): turns a request from the local bridge
// (src-tauri/src/device_bridge.rs: argv + the per-chat token) into a device tool call and the text the CLI agent prints.
// Pure of Tauri: deviceBridgeNative.ts connects it to the real bridge. One token per chat identifies who asks; a request
// is served only while that chat's agent run is active, so approvals and Stop work exactly as for the API tools.
import { cliErrorText, parseDeviceArgv } from "./deviceCli";
import { DEVICE_TOOL_NAMES, describeDeviceCall } from "./deviceCore";
import { DeviceDeclined, runDeviceTool, type DeviceToolContext } from "./deviceTools";
import type { DeviceSettings } from "./deviceSettings";
import { createTokenRegistry, type BridgeReply, type BridgeRequest, type TokenRegistry } from "./bridgeTokens";

export type { BridgeReply, BridgeRequest };

/** What the running agent turn of a chat provides: its Stop signal and its approval card. */
export type BridgeTurn = { signal: AbortSignal; approve: DeviceToolContext["approve"]; askFirst: boolean };

export type BridgeDeps = {
  settings: () => Promise<DeviceSettings>;
  run?: typeof runDeviceTool;
  /** Shared with the other bridge commands; default: this bridge's own. */
  tokens?: TokenRegistry;
  /** Records the call in the action log; returns the function that closes the entry. */
  audit?: (
    tool: string,
    summary: string,
  ) => (status: "success" | "error" | "declined" | "cancelled", detail?: string) => void;
};

const TOOL_NAME = new RegExp(`\\b(${DEVICE_TOOL_NAMES.join("|")})\\b`, "g");

/** The tools' messages name tools (`device_snapshot`); a CLI agent runs commands (`gustaf-device snapshot`). */
export const cliWording = (text: string) =>
  text.replace(TOOL_NAME, (name) => `gustaf-device ${name.slice("device_".length).replace(/_/g, "-")}`);

export function createDeviceBridge(deps: BridgeDeps) {
  const tokens = deps.tokens ?? createTokenRegistry();
  const turns = new Map<number, BridgeTurn>();
  const run = deps.run ?? runDeviceTool;

  return {
    /** The chat's token (stable for the app session: a live CLI process keeps the one it was started with). */
    tokenFor: (chatId: number): string => tokens.tokenFor(chatId),
    /** The chat's agent run starts (or continues): requests with its token are served until the returned function runs. */
    beginTurn(chatId: number, turn: BridgeTurn): () => void {
      turns.set(chatId, turn);
      return () => {
        if (turns.get(chatId) === turn) turns.delete(chatId);
      };
    },
    async handle(req: BridgeRequest): Promise<BridgeReply> {
      const fail = (text: string): BridgeReply => ({ ok: false, text });
      const chatId = tokens.chatFor(req.token);
      if (chatId === undefined) return fail("gustaf-device: unknown session. Start a new message in Gustaf.");
      if (!(await deps.settings()).access)
        return fail(
          "gustaf-device: agent device access is off. The user can turn it on in Settings > Computer use > Devices.",
        );
      const turn = turns.get(chatId);
      if (!turn || turn.signal.aborted)
        return fail("gustaf-device: no agent run is active in this chat, so the command is not available now.");
      const parsed = parseDeviceArgv(req.argv);
      if (!parsed.ok) return fail(cliErrorText(parsed.error));
      const done = deps.audit?.(parsed.tool, describeDeviceCall(parsed.tool, parsed.args));
      try {
        const r = await run(parsed.tool, parsed.args, {
          chatId,
          signal: turn.signal,
          askFirst: turn.askFirst,
          approve: turn.approve,
        });
        done?.("success");
        return { ok: true, text: cliWording(r.output), ...(r.image ? { image: r.image } : {}) };
      } catch (e) {
        const message = String((e as { message?: string })?.message ?? e);
        if (e instanceof DeviceDeclined) {
          done?.("declined");
          return fail("The user declined device access. Do not retry; ask the user how to proceed.");
        }
        if (turn.signal.aborted || (e as { name?: string })?.name === "AbortError") {
          done?.("cancelled");
          return fail("Stopped by the user.");
        }
        done?.("error", message);
        return fail(cliWording(message));
      }
    },
  };
}
