/**
 * Puts a drafted message into the composer of a chat from outside it (the merge queue's "Resolve with agent"). The text is
 * only placed in the message box for the user to edit and send: nothing here ever sends. A draft is kept until the
 * chat's composer takes it (the chat may not be mounted yet when the request is made).
 */
const pending = new Map<number, string[]>();
const subscribers = new Set<() => void>();

export function requestComposerDraft(chatId: number, text: string) {
  if (!text.trim()) return;
  pending.set(chatId, [...(pending.get(chatId) ?? []), text]);
  subscribers.forEach((fn) => fn());
}
/** The drafts waiting for this chat (joined with a blank line), removed from the queue; null when none. */
export function takeComposerDraft(chatId: number | null): string | null {
  if (chatId === null) return null;
  const texts = pending.get(chatId);
  if (!texts) return null;
  pending.delete(chatId);
  return texts.join("\n\n");
}
export function onComposerDraft(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
/** Test helper. */
export const clearComposerDrafts = () => pending.clear();
