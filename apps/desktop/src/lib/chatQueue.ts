import { getSetting, setSetting } from "./api";
export type PendingMessage = { id: string; text: string; images: string[]; clarify: boolean };
export type QueueState = { items: PendingMessage[]; paused: boolean; interrupted?: boolean; active?: boolean };
const blank = (): QueueState => ({ items: [], paused: true });
const cache = new Map<number, QueueState>();
const loading = new Map<number, Promise<void>>();
const writes = new Map<number, Promise<unknown>>();
const listeners = new Set<() => void>();
export const subscribeQueue = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const getQueue = (id: number | null) => (id ? cache.get(id) : undefined);
export function validateQueue(value: unknown): QueueState {
  const q = value && typeof value === "object" ? (value as Partial<QueueState>) : {};
  const items = Array.isArray(q.items)
    ? q.items
        .filter((i) => i && typeof i.id === "string" && typeof i.text === "string" && Array.isArray(i.images))
        .slice(0, 100)
        .map((i) => ({
          id: i.id,
          text: i.text.slice(0, 200000),
          images: i.images.filter((v) => typeof v === "string").slice(0, 8),
          clarify: i.clarify === true,
        }))
    : [];
  return { items, paused: true, interrupted: q.interrupted === true || q.active === true, active: false };
}
export function loadQueue(id: number) {
  if (!loading.has(id))
    loading.set(
      id,
      getSetting<QueueState>("chat-queue-" + id, blank())
        .then((q) => {
          // Recovery is explicit: restored work never automatically restarts.
          if (!cache.has(id)) cache.set(id, validateQueue(q));
          listeners.forEach((fn) => fn());
        })
        .catch((e) => {
          loading.delete(id);
          throw e;
        }),
    );
  return loading.get(id)!;
}
export function updateQueue(id: number, fn: (q: QueueState) => QueueState) {
  const q = fn(cache.get(id) ?? blank());
  cache.set(id, q);
  listeners.forEach((fn) => fn());
  const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => setSetting("chat-queue-" + id, q));
  writes.set(id, write);
  return write;
}
