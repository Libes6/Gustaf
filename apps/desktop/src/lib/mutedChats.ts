// Chats whose notifications are off (T13): set from the chat menu, kept in the "mutedChats" setting. Badges and the
// unread mark stay; only system notifications (and the dock bounce) are skipped for these chats.
import { getSetting, setSetting } from "./api";

let muted = new Set<number>();
let loaded = false;
const listeners = new Set<() => void>();
let version = 0;
export const subscribeMuted = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const mutedVersion = () => version;
export const isMuted = (chatId: number | null | undefined) => chatId != null && muted.has(chatId);

export function loadMuted() {
  if (loaded) return;
  loaded = true;
  getSetting<unknown>("mutedChats", []).then((v) => {
    if (Array.isArray(v)) muted = new Set([...muted, ...v.filter((x): x is number => Number.isInteger(x))]);
    version++; listeners.forEach((fn) => fn());
  }).catch(() => { loaded = false; });
}

export function setMuted(chatId: number, on: boolean) {
  muted = new Set(muted);
  if (on) muted.add(chatId); else muted.delete(chatId);
  void setSetting("mutedChats", [...muted].slice(-500)).catch(() => {});
  version++; listeners.forEach((fn) => fn());
}
