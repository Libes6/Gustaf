// Goals per chat, kept in app settings (`chat-goal-<id>`) with an in-memory cache and change listeners, like chatQueue.ts.
import { getSetting, setSetting } from "./api";
import type { Goal } from "./goalCore";

const cache = new Map<number, Goal | null>();
const loading = new Map<number, Promise<void>>();
const writes = new Map<number, Promise<unknown>>();
const listeners = new Set<() => void>();
let version = 0;

export const subscribeGoals = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getGoal = (id: number | null): Goal | null => (id ? cache.get(id) ?? null : null);
/** Changes with every goal update; the sidebar uses it to re-read active goals. */
export const goalsVersion = () => version;
export const activeGoalChats = () => [...cache].filter(([, g]) => g?.status === "active").map(([id]) => id);

const notify = () => { version++; listeners.forEach((fn) => fn()); };

const valid = (v: unknown): Goal | null => {
  const g = v as Partial<Goal> | null;
  if (!g || typeof g.objective !== "string" || !["active", "paused", "done", "blocked"].includes(g.status as string)) return null;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
  // A goal restored after a restart never continues by itself: it waits for Resume.
  const status = g.status === "active" ? "paused" : g.status!;
  return { objective: g.objective, status, turns: n(g.turns), maxTurns: n(g.maxTurns) || 20, tokens: n(g.tokens), startedAt: n(g.startedAt), note: g.status === "active" ? "restart" : typeof g.note === "string" ? g.note : undefined };
};

export function loadGoal(id: number) {
  if (!loading.has(id)) loading.set(id, getSetting<unknown>(`chat-goal-${id}`, null).then((g) => {
    if (!cache.has(id)) { cache.set(id, valid(g)); notify(); }
  }).catch((e) => { loading.delete(id); throw e; }));
  return loading.get(id)!;
}

export function setGoal(id: number, goal: Goal | null) {
  cache.set(id, goal);
  notify();
  const write = (writes.get(id) ?? Promise.resolve()).catch(() => {}).then(() => setSetting(`chat-goal-${id}`, goal));
  writes.set(id, write);
  return write;
}

export const updateGoal = (id: number, fn: (g: Goal) => Goal) => {
  const g = cache.get(id);
  return g ? setGoal(id, fn(g)) : Promise.resolve();
};
