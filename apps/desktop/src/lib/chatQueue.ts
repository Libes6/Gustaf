import { getSetting, setSetting } from './api';
export type PendingMessage = { id: string; text: string; images: string[]; clarify: boolean };
export type QueueState = { items: PendingMessage[]; paused: boolean; interrupted?: boolean };
const blank = (): QueueState => ({ items: [], paused: true });
const cache = new Map<number, QueueState>();
const loading = new Map<number, Promise<void>>();
const writes = new Map<number, Promise<unknown>>();
const listeners = new Set<() => void>();
export const subscribeQueue = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getQueue = (id: number | null) => id ? cache.get(id) : undefined;
export function loadQueue(id: number) {
  if (!loading.has(id)) loading.set(id, getSetting<QueueState>('chat-queue-' + id, blank()).then(q => {
    // Recovery is explicit: restored work never automatically restarts.
    cache.set(id, { ...q, paused: true, interrupted: q.interrupted }); listeners.forEach(fn => fn());
  }));
  return loading.get(id)!;
}
export function updateQueue(id: number, fn: (q: QueueState) => QueueState) {
  const q = fn(cache.get(id) ?? blank()); cache.set(id, q); listeners.forEach(fn => fn());
  const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => setSetting('chat-queue-' + id, q));
  writes.set(id, write); return write;
}
