import { useEffect, useRef, useState } from "react";
import { draftScope, type Draft } from "./chatSessions";
import { draftSaver, loadDraft } from "./data";

let hideFlushInstalled = false;
/** Debounced edits are written when the window is hidden or closing, so quitting right after typing keeps the draft. */
function installHideFlush() {
  if (hideFlushInstalled) return;
  hideFlushInstalled = true;
  const flush = () => void draftSaver.flush();
  addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => document.hidden && flush());
}

/**
 * Persists the composer (text + attached images) of one chat session in SQLite.
 * - Restores the stored draft once, when the session opens, unless the composer already has content.
 * - Saves edits debounced (see `createDraftSaver`); nothing is written until the restore has finished, so the
 *   initial empty composer can never overwrite a stored draft.
 * - A new chat gets its real chat id when the first message is sent: the draft then moves to the chat's scope.
 * - `clearSent(chatId)` deletes the stored draft once the message has been saved.
 */
export function useComposerDraft(
  session: { chatId: number | null; projectId: number | null },
  text: string,
  images: string[],
  restore: (draft: Draft) => void,
) {
  const scope = draftScope(session.chatId, session.projectId);
  const latest = useRef({ text, images, restore });
  useEffect(() => {
    latest.current = { text, images, restore };
  });
  const ready = useRef(false);
  const prevScope = useRef(scope);
  const [epoch, setEpoch] = useState(0);

  useEffect(() => {
    installHideFlush();
    let alive = true;
    const mounted = scope;
    (async () => {
      let stored: Draft | null | undefined;
      try {
        stored = await loadDraft(mounted);
      } catch {
        stored = undefined; // unknown: the saver then writes in full instead of assuming what is stored
      }
      if (!alive) return;
      if (stored !== undefined) draftSaver.seed(mounted, stored);
      const now = latest.current;
      // Skip when the chat was created meanwhile (the user already sent from this composer) or the user typed.
      if (stored && prevScope.current === mounted && !now.text && !now.images.length) now.restore(stored);
      ready.current = true;
      setEpoch((e) => e + 1);
    })();
    return () => {
      alive = false;
    };
    // Mount only: the scope changes later solely because this session's first message created its chat.
  }, []);

  useEffect(() => {
    if (prevScope.current === scope) return;
    void draftSaver.clear(prevScope.current);
    prevScope.current = scope;
  }, [scope]);

  useEffect(() => {
    if (ready.current) draftSaver.schedule(scope, { text, images });
  }, [scope, text, images, epoch]);

  return { clearSent: (chatId: number) => void draftSaver.clear(draftScope(chatId, null)) };
}
