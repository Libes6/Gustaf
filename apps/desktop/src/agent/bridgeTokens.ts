// One bearer token per chat for the local CLI bridge (src-tauri/src/device_bridge.rs). Both commands the bridge serves
// (`gustaf-device`, `gustaf-agent`) share the registry, so an agent process gets one environment for all of them.
// Pure of Tauri.

export type TokenRegistry = {
  /** The chat's token (stable for the app session: a live CLI process keeps the one it was started with). */
  tokenFor(chatId: number): string;
  /** The chat a token belongs to; undefined for an unknown token. */
  chatFor(token: string): number | undefined;
};

const randomToken = () => `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");

export function createTokenRegistry(newToken: () => string = randomToken): TokenRegistry {
  const tokenByChat = new Map<number, string>();
  const chatByToken = new Map<string, number>();
  return {
    tokenFor(chatId) {
      let t = tokenByChat.get(chatId);
      if (!t) {
        t = newToken();
        tokenByChat.set(chatId, t);
        chatByToken.set(t, chatId);
      }
      return t;
    },
    chatFor: (token) => chatByToken.get(token),
  };
}

/** What the bridge hands the webview for one launcher call. `command` is absent in requests from older builds (= device). */
export type BridgeRequest = { id: number; token: string; argv: string[]; command?: string; input?: string | null };
export type BridgeReply = { ok: boolean; text: string; image?: string };
