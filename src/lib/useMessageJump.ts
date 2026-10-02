import { useEffect, useState, type RefObject } from "react";
import { JUMP_TTL_MS, nearestMessageId, type Jump } from "./searchUtil";

/** How long the target message stays highlighted after a jump (matches the CSS animation in styles/search.css). */
export const FLASH_MS = 2400;

type Options = {
  /** Pending request from `useApp().jump`; only handled when it is for this chat. */
  jump: Jump | null;
  clearJump: () => void;
  chatId: number | null;
  /** The chat is on screen (a hidden chat has no layout to scroll). */
  visible: boolean;
  /** Messages of this chat have been loaded. */
  loaded: boolean;
  messages: readonly { id: number }[];
  /** Scroll container; rendered messages carry `data-msg-id`. */
  feedRef: RefObject<HTMLElement | null>;
  /** Called right before scrolling, so the view stops following the bottom of the feed. */
  onJump: () => void;
};

/**
 * Scrolls the chat feed to the message a search result points at (or the nearest one if it is gone) and returns
 * the id to highlight, or null. The scroll happens in an effect after the render that shows the highlight, so
 * collapsed steps containing the message are already expanded by then.
 */
export function useMessageJump({ jump, clearJump, chatId, visible, loaded, messages, feedRef, onJump }: Options): number | null {
  const [focus, setFocus] = useState<{ id: number; seq: number } | null>(null);

  useEffect(() => {
    if (!jump || chatId === null || jump.chatId !== chatId) return;
    if (Date.now() - jump.seq > JUMP_TTL_MS) return clearJump();
    if (!visible || !loaded) return;
    clearJump();
    const id = nearestMessageId(messages.map((m) => m.id), jump.messageId);
    if (id === null) return;
    onJump();
    setFocus({ id, seq: jump.seq });
  }, [jump, chatId, visible, loaded, messages]);

  useEffect(() => {
    if (!focus) return;
    feedRef.current?.querySelector(`[data-msg-id="${focus.id}"]`)?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setFocus(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [focus]);

  return focus?.id ?? null;
}
