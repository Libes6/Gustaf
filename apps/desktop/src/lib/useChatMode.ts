import { useCallback, useEffect, useRef, useState } from "react";
import { loadChatMode, saveChatMode } from "../agent/chatModeStore";
import { DEFAULT_CHAT_MODE, type ChatMode } from "../agent/planCore";

/**
 * Ask / Plan / Agent of one chat, persisted per chat id (settings key `chatModes`; chats without an entry are in Agent mode).
 * A chat that is not created yet keeps its mode in memory; it is stored when the chat gets its id on the first send.
 */
export function useChatMode(chatId: number | null): [ChatMode, (m: ChatMode) => void] {
  const [mode, setModeState] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  const modeRef = useRef(mode);
  const prevId = useRef(chatId);
  useEffect(() => {
    const before = prevId.current;
    prevId.current = chatId;
    if (chatId === null) {
      if (before !== null) {
        modeRef.current = DEFAULT_CHAT_MODE;
        setModeState(DEFAULT_CHAT_MODE);
      }
      return;
    }
    // New chat promoted to its real id: keep what the user picked and store it.
    if (before === null) {
      void saveChatMode(chatId, modeRef.current);
      return;
    }
    let cancelled = false;
    modeRef.current = DEFAULT_CHAT_MODE;
    setModeState(DEFAULT_CHAT_MODE);
    loadChatMode(chatId).then((m) => {
      if (!cancelled) {
        modeRef.current = m;
        setModeState(m);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId]);
  const setMode = useCallback((m: ChatMode) => {
    modeRef.current = m;
    setModeState(m);
    if (prevId.current !== null) void saveChatMode(prevId.current, m);
  }, []);
  return [mode, setMode];
}
