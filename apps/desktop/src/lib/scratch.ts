// Scratch chats (T8): a chat without a project that still gets a folder to work in,
// `<app data>/scratch/<date>-<title>-<id>` (src-tauri/src/scratch.rs). Only chats started as scratch chats have one;
// ordinary chats without a project keep having no files. The ids live in the "scratchChats" setting.
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./api";
import { createChat } from "./data";
import { translate, type Locale } from "../i18n";

let ids = new Set<number>();
let loaded: Promise<void> | null = null;
const roots = new Map<number, Promise<string>>();
const listeners = new Set<() => void>();
let version = 0;

export const subscribeScratch = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const scratchVersion = () => version;
export const isScratch = (chatId: number | null | undefined) => !!chatId && ids.has(chatId);
const emit = () => { version++; listeners.forEach((fn) => fn()); };

export function loadScratch() {
  loaded ??= getSetting<unknown>("scratchChats", []).then((v) => {
    if (Array.isArray(v)) ids = new Set([...ids, ...v.filter((x): x is number => Number.isInteger(x) && x > 0)]);
    emit();
  }).catch(() => { loaded = null; });
  return loaded;
}

/** The chat's folder, created on first use (the same folder every time for a chat). */
export function scratchRoot(chatId: number, title: string): Promise<string> {
  if (!roots.has(chatId)) {
    const date = new Date().toISOString().slice(0, 10);
    roots.set(chatId, invoke<string>("scratch_dir", { chatId, name: `${date} ${title}` }).catch((e) => { roots.delete(chatId); throw e; }));
  }
  return roots.get(chatId)!;
}

/** Creates a scratch chat (stored at once, so its folder can carry the id) and returns its id. */
export async function createScratchChat(title: string): Promise<number> {
  await loadScratch();
  const id = await createChat(null, title);
  ids = new Set(ids).add(id);
  await setSetting("scratchChats", [...ids].slice(-500));
  emit();
  return id;
}

/** Starts a scratch chat from the app (shortcut, sidebar): creates it, refreshes the list and opens it. */
export async function startScratchChat(app: { locale: string; reload(): Promise<void>; openChat(id: number, projectId: number | null): void; setView(v: "chat"): void }) {
  const title = translate(app.locale as Locale, "scratchTitle", { date: new Intl.DateTimeFormat(app.locale, { dateStyle: "medium", timeStyle: "short" }).format(Date.now()) });
  const id = await createScratchChat(title);
  await app.reload();
  app.openChat(id, null);
  app.setView("chat");
}
