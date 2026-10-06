// Settled / snoozed chats (lib/triageCore.ts) in app settings ("chatTriage"), with a one-step undo for ⌘Z.
import { getSetting, setSetting } from "./api";
import { parseTriage, type TriageMap } from "./triageCore";

let map: TriageMap = {};
let undo: { before: TriageMap; label: string } | null = null;
const listeners = new Set<() => void>();
let loaded = false;

export const subscribeTriage = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getTriage = () => map;
export const lastUndo = () => undo;

const emit = () => listeners.forEach((fn) => fn());
const save = () => setSetting("chatTriage", map).catch(() => {});

export function loadTriage() {
  if (loaded) return;
  loaded = true;
  getSetting<unknown>("chatTriage", {}).then((v) => { map = { ...parseTriage(v), ...map }; emit(); }).catch(() => { loaded = false; });
}

/** Applies a change; `label` names it for the undo notice (empty: an automatic change, not undoable). */
export function changeTriage(fn: (m: TriageMap) => TriageMap, label = "") {
  const before = map;
  const next = fn(map);
  if (next === map) return;
  map = next;
  if (label) undo = { before, label };
  save();
  emit();
}

/** Reverts the last user change; false when there is nothing to undo. */
export function undoTriage() {
  if (!undo) return false;
  map = undo.before;
  undo = null;
  save();
  emit();
  return true;
}

export const dismissUndo = () => { if (undo) { undo = null; emit(); } };
