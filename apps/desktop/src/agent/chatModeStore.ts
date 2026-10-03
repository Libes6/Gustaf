import { getSetting, setSetting } from "../lib/api";
import { CHAT_MODES_SETTING, chatModeOf, normalizeChatModes, withChatMode, type ChatMode } from "./planCore";

/** Mode of one chat from the `settings` table (Agent when nothing is stored or it cannot be read). */
export const loadChatMode = async (chatId: number): Promise<ChatMode> =>
  chatModeOf(normalizeChatModes(await getSetting<unknown>(CHAT_MODES_SETTING, null).catch(() => null)), chatId);

let queue: Promise<unknown> = Promise.resolve();
/** Stores the mode of one chat; writes are serialized so quick switches cannot overwrite each other. */
export const saveChatMode = (chatId: number, mode: ChatMode): Promise<void> =>
  (queue = queue.then(async () => {
    const map = normalizeChatModes(await getSetting<unknown>(CHAT_MODES_SETTING, null).catch(() => null));
    await setSetting(CHAT_MODES_SETTING, withChatMode(map, chatId, mode));
  }).catch(() => {})) as Promise<void>;
