// Per-chat status shown in the sidebar: waiting for approval > running > failed > done-unread. Pure (no React, no Tauri):
// `deriveStatus` combines the flags that the existing stores already know (session busy, scheduled live run, open approval)
// with two flags kept here: "unread" (a run finished while the chat was not in front of the user) and "failed" (the last run
// ended in an error). Only the unread set is persisted (a bounded list in the settings table); see useChatStatusSync in attention.ts.

export type ChatStatus = "waiting" | "running" | "failed" | "unread";
export type StatusInput = { waiting?: boolean; running?: boolean; failed?: boolean; unread?: boolean };

/** The one status a chat row shows; the most urgent first. */
export function deriveStatus(i: StatusInput): ChatStatus | null {
  return i.waiting ? "waiting" : i.running ? "running" : i.failed ? "failed" : i.unread ? "unread" : null;
}

/** Persisted unread ids are bounded: the newest are kept. */
export const UNREAD_LIMIT = 200;
export const UNREAD_KEY = "unreadChats";

/** Tolerant reader for the stored value. */
export function parseUnread(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((x): x is number => Number.isInteger(x) && x > 0);
  return [...new Set(ids)].slice(-UNREAD_LIMIT);
}

export type StatusFlags = { unread: ReadonlySet<number>; failed: ReadonlySet<number> };

/** A tiny external store (useSyncExternalStore-compatible) for the unread / failed flags. */
export function createStatusStore() {
  let unread: number[] = [];
  let failed = new Set<number>();
  let viewing: number | null = null;
  let snap: StatusFlags = { unread: new Set(), failed: new Set() };
  const listeners = new Set<() => void>();
  const emit = () => {
    snap = { unread: new Set(unread), failed: new Set(failed) };
    listeners.forEach((l) => l());
  };
  const without = (set: Set<number>, id: number) => new Set([...set].filter((x) => x !== id));
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    get: () => snap,
    /** The unread ids, oldest first (what is persisted). */
    unreadIds: () => [...unread],
    /** Restores the persisted unread ids (at startup); the chat in front of the user stays read. */
    load(ids: unknown) {
      unread = [...new Set([...parseUnread(ids), ...unread])].slice(-UNREAD_LIMIT);
      if (viewing !== null) unread = unread.filter((x) => x !== viewing);
      emit();
    },
    /** The chat in front of the user (visible and the window focused), or null. Opening clears both flags. */
    setViewing(chatId: number | null) {
      viewing = chatId;
      if (chatId === null) return;
      const hadUnread = unread.includes(chatId);
      if (!hadUnread && !failed.has(chatId)) return;
      unread = unread.filter((x) => x !== chatId);
      failed = without(failed, chatId);
      emit();
    },
    /** A run starts: an earlier failure no longer applies. */
    runStarted(chatId: number) {
      if (!failed.has(chatId)) return;
      failed = without(failed, chatId);
      emit();
    },
    /** A run ended (interactive or scheduled). A stopped run changes nothing. */
    runEnded(chatId: number, outcome: "ok" | "failed" | "stopped") {
      if (outcome === "stopped") return;
      if (outcome === "failed") {
        failed = new Set(failed).add(chatId);
        unread = unread.filter((x) => x !== chatId);
      } else {
        failed = without(failed, chatId);
        if (viewing !== chatId) unread = [...unread.filter((x) => x !== chatId), chatId].slice(-UNREAD_LIMIT);
      }
      emit();
    },
    /** The chat was deleted. */
    forget(chatId: number) {
      if (!unread.includes(chatId) && !failed.has(chatId)) return;
      unread = unread.filter((x) => x !== chatId);
      failed = without(failed, chatId);
      emit();
    },
  };
}

export const chatStatusStore = createStatusStore();
