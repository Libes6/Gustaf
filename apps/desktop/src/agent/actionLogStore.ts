import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../lib/api";
import { undoFileEdit } from "../lib/checkpoints";
import type { UndoResult } from "../lib/fileUndo";
import { ACTION_LOG_SETTING, appendEntry, clipDetail, mergeLogs, normalizeActionLog, patchEntry, undoBlocker, type ActionEntry, type ActionStatus, type HookMeta, type GateMeta } from "./actionLog";

// One shared in-memory log (several chats can run at once), persisted to the app settings shortly after each change.
let entries: ActionEntry[] = [];
const running = new Map<string, number>();
let snapshot: { entries: readonly ActionEntry[]; active: ReadonlySet<string> } = { entries, active: new Set() };
let loading: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let counter = 0;
const listeners = new Set<() => void>();

const emit = () => {
  snapshot = { entries, active: new Set(running.keys()) };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const load = () => {
  loading ??= getSetting<unknown>(ACTION_LOG_SETTING, [])
    .then((raw) => {
      entries = mergeLogs(normalizeActionLog(raw), entries);
      emit();
    })
    .catch(() => {
      loading = undefined;
    });
  return loading;
};

async function persist() {
  await load();
  setSetting(ACTION_LOG_SETTING, entries).catch(() => {});
}
/** Writes are batched: an agent run can make dozens of calls in a few seconds. */
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(() => void persist(), now ? 0 : 800);
}
const change = (next: ActionEntry[], now = false) => {
  entries = next;
  emit();
  schedule(now);
};

export type ActionStart = { tool: string; summary: string; root?: string; project?: string; source?: "scheduled" | "hook" | "gate"; hook?: HookMeta; gate?: GateMeta };

/** Records a tool call that is about to run; returns its id. */
export function logStart(a: ActionStart): string {
  void load();
  const id = `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  change(appendEntry(entries, { id, at: Date.now(), status: "running", ...a }));
  return id;
}

export const logPatch = (id: string, patch: Partial<ActionEntry>) => change(patchEntry(entries, id, patch));

export function logFinish(id: string, status: ActionStatus, detail?: string) {
  const started = entries.find((e) => e.id === id)?.at ?? Date.now();
  change(patchEntry(entries, id, { status, durationMs: Date.now() - started, ...(detail ? { detail: clipDetail(detail) } : {}) }));
}

/** While a run is active in a folder, edits made there cannot be undone (the agent may be editing the same files). */
export function beginRun(root: string) {
  running.set(root, (running.get(root) ?? 0) + 1);
  emit();
}
export function endRun(root: string) {
  const n = (running.get(root) ?? 1) - 1;
  if (n > 0) running.set(root, n);
  else running.delete(root);
  emit();
  schedule(true);
}

export function clearActionLog() {
  change(entries.filter((e) => e.status === "running"), true);
}

export function useActionLog() {
  useEffect(() => void load(), []);
  return useSyncExternalStore(subscribe, () => snapshot);
}

/** The current log outside React (used by tests). */
export const getActionLog = () => snapshot;

export type UndoOutcome = UndoResult | { ok: false; reason: "busy" | "later" | "done" | "none" };

/** Undoes one logged file edit if that is still provably safe (see lib/fileUndo.ts). */
export async function undoLogEntry(id: string): Promise<UndoOutcome> {
  const entry = entries.find((e) => e.id === id);
  if (!entry?.undo) return { ok: false, reason: "none" };
  const block = undoBlocker(entries, entry, new Set(running.keys()));
  if (block === "undone") return { ok: false, reason: "done" };
  if (block === "running") return { ok: false, reason: "busy" };
  if (block === "later") return { ok: false, reason: "later" };
  const result = await undoFileEdit(entry.undo);
  if (result.ok) change(patchEntry(entries, id, { undo: { ...entry.undo, undone: Date.now() } }), true);
  return result;
}
