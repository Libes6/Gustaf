import { useSyncExternalStore } from "react";

// Approval requests raised by unattended (scheduled) runs. A scheduled chat is usually not the visible one, so its
// requests are listed here and answered from a floating card (components/ScheduledPromptsRuntime.tsx); the sidebar badge
// and the native notification come from lib/attention.ts. Nothing here ever answers for the user.

export type ScheduledApproval = {
  id: number;
  scheduleId: string;
  chatId: number | null;
  title: string;
  command: string;
  at: number;
};

let seq = 0;
let items: readonly ScheduledApproval[] = [];
const answers = new Map<number, (ok: boolean) => void>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Lists a request; `onAnswer` is called once when the user answers. Returns a function that withdraws the request. */
export function openScheduledApproval(
  info: Omit<ScheduledApproval, "id" | "at">,
  onAnswer: (ok: boolean) => void,
): () => void {
  const id = ++seq;
  items = [...items, { ...info, id, at: Date.now() }];
  answers.set(id, onAnswer);
  emit();
  return () => {
    if (!answers.delete(id)) return;
    items = items.filter((i) => i.id !== id);
    emit();
  };
}

/** The user's answer. A request that is already gone (timed out, run stopped) is ignored. */
export function answerScheduledApproval(id: number, ok: boolean) {
  const answer = answers.get(id);
  if (!answer) return;
  answers.delete(id);
  items = items.filter((i) => i.id !== id);
  emit();
  answer(ok);
}

export const getScheduledApprovals = () => items;
export const useScheduledApprovals = () => useSyncExternalStore(subscribe, () => items);
