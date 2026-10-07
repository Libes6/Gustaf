import { useCallback, useEffect, useRef, useState } from "react";
import { shouldAutoSuggest, type Suggestion } from "../agent/memorySuggest";
import { useApp } from "../state";
import { getSetting } from "./api";
import { loadMessages } from "./data";
import { suggestMemories } from "./memorySuggestRun";

/** User-message count at the last automatic attempt, per chat, for this app session (not persisted: a restart may ask again). */
const attempts = new Map<number, number>();
export const resetAutoSuggestAttempts = () => attempts.clear();

/**
 * The opt-in "suggest memories at the end of chats" (setting `memorySuggestAuto`, default off). When a run of this chat ends it
 * makes the one cheap-model request (lib/memorySuggestRun.ts) for chats with enough conversation, at most once per few user
 * messages, and returns the new suggestions so the caller can open the dialog; nothing is saved here and failures stay silent
 * (the manual action in the chat menu shows them).
 */
export function useAutoMemorySuggest(o: {
  chatId: number | null;
  running: boolean;
  active: boolean;
  projectRoot: string | null;
}) {
  const app = useApp();
  const latest = useRef({ app, o });
  latest.current = { app, o };
  const [found, setFound] = useState<{ chatId: number; suggestions: Suggestion[] } | null>(null);
  const was = useRef(o.running);
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => {
    const ended = was.current && !o.running;
    was.current = o.running;
    if (!ended || !o.active || o.chatId === null) return;
    const chatId = o.chatId;
    (async () => {
      if (!(await getSetting("memorySuggestAuto", false)) || !(await getSetting("memoryEnabled", true))) return;
      const users = (await loadMessages(chatId)).filter((m) => m.role === "user").length;
      if (!shouldAutoSuggest(users, attempts.get(chatId))) return;
      attempts.set(chatId, users);
      ctl.current?.abort();
      const c = new AbortController();
      ctl.current = c;
      const r = await suggestMemories(latest.current.app, {
        chatId,
        projectRoot: latest.current.o.projectRoot,
        signal: c.signal,
        auto: true,
      });
      if (!c.signal.aborted && r.suggestions.length) setFound({ chatId, suggestions: r.suggestions });
    })().catch(() => {});
  }, [o.running]);
  return { found, dismiss: useCallback(() => setFound(null), []) };
}
