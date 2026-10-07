// PR watches per chat (lib/prWatchCore.ts): stored in the "prWatches" setting, polled once a minute while the app runs.
// A change worth acting on is put into the chat's queue as a message, so the agent picks it up like any queued message
// (at once when the chat is open and idle, otherwise when the user opens it); the chat is marked and, when the window is
// in the background, a notification is shown.
import { invoke } from "@tauri-apps/api/core";
import { getSetting, setSetting } from "./api";
import { notifyUnfocused } from "./attention";
import { chatStatusStore } from "./chatStatus";
import { updateQueue } from "./chatQueue";
import { parseSnapshot, POLL_MS, step, wakeMessage, type PrWatch } from "./prWatchCore";

let watches: Record<number, PrWatch> = {};
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();
let version = 0;
export const subscribePrWatches = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const prWatchesVersion = () => version;
export const getPrWatch = (chatId: number | null) => (chatId ? (watches[chatId] ?? null) : null);
const emit = () => {
  version++;
  listeners.forEach((fn) => fn());
};
const save = () => setSetting("prWatches", watches).catch(() => {});

export function loadPrWatches() {
  loaded ??= getSetting<Record<number, PrWatch>>("prWatches", {})
    .then((v) => {
      if (v && typeof v === "object") watches = { ...v, ...watches };
      emit();
    })
    .catch(() => {
      loaded = null;
    });
  return loaded;
}

/** `/watch <url or number>` in a chat: starts (or restarts) watching that PR from the chat's folder. */
export const parseWatchCommand = (text: string) => /^\/watch(?:-pr)?\s+(\S+)\s*$/.exec(text.trim())?.[1] ?? null;

export async function startPrWatch(chatId: number, root: string, pr: string) {
  await loadPrWatches();
  const snapshot = parseSnapshot(await invoke<string>("gh_pr_view", { root, pr }));
  const now = Date.now();
  const first = step({ chatId, root, pr, startedAt: now, okAt: now, commentWakes: 0 }, { ok: true, snapshot }, now);
  watches = { ...watches, [chatId]: first.watch };
  save();
  emit();
  return first.watch;
}

export function stopPrWatch(chatId: number) {
  const w = watches[chatId];
  if (!w) return;
  watches = { ...watches, [chatId]: { ...w, stopped: { reason: "user", at: Date.now() } } };
  save();
  emit();
}

export function clearPrWatch(chatId: number) {
  const { [chatId]: _gone, ...rest } = watches;
  watches = rest;
  save();
  emit();
}

/** One round over the active watches (exported for tests). */
export async function pollPrWatches(
  now = Date.now(),
  view = (root: string, pr: string) => invoke<string>("gh_pr_view", { root, pr }),
) {
  await loadPrWatches();
  for (const w of Object.values(watches)) {
    if (w.stopped) continue;
    const r = await view(w.root, w.pr).then(
      (json) => ({ ok: true as const, snapshot: parseSnapshot(json) }),
      (e) => ({ ok: false as const, error: String(e) }),
    );
    const next = step(w, r, now);
    watches = { ...watches, [w.chatId]: next.watch };
    if (next.events.length && next.watch.last) {
      const text = wakeMessage(next.watch.last, next.events);
      await updateQueue(w.chatId, (q) => ({
        ...q,
        paused: false,
        interrupted: false,
        items: [...q.items, { id: crypto.randomUUID(), text, images: [], clarify: false }],
      })).catch(() => {});
      chatStatusStore.runEnded(w.chatId, "ok");
      void notifyUnfocused(next.watch.last.title || "Pull request", text.split("\n").slice(1).join(" ").slice(0, 180));
    }
  }
  save();
  emit();
}

/** Starts the minute poller; returns the cleanup. Called once by the app shell. */
export function startPrWatchPoller() {
  void loadPrWatches();
  let busy = false;
  const tick = () => {
    if (busy || !Object.values(watches).some((w) => !w.stopped)) return;
    busy = true;
    void pollPrWatches().finally(() => {
      busy = false;
    });
  };
  const timer = setInterval(tick, POLL_MS);
  return () => clearInterval(timer);
}
