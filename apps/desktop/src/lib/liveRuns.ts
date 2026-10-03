import type { ApprovalRequest } from "../agent/agent";
import type { Part } from "../providers/types";
import type { LiveStats } from "../components/LiveMeter";

// Live state of runs that write to a chat without the chat's own composer: scheduled runs. The chat view (lib/useChatRun.ts)
// reads this store instead of its own state while such a run is active, so an open chat shows the streamed text, tool
// cards and approval, offers Stop and refuses new messages exactly like during an interactive run; the sidebar shows the
// chat as running. Messages are stored in the database by the run; `seq` changes whenever one was stored (and when the run
// ends) so a visible chat reloads them. Pure (no React, no Tauri): the hooks live in useChatRun.ts and Sidebar.tsx.

export type LiveApproval = { req: ApprovalRequest; resolve: (ok: boolean, always?: boolean) => void };
export type LiveRun = {
  chatId: number;
  title: string;
  /** "" while the model works without output yet; never null while the run is registered. */
  stream: string;
  activities: Extract<Part, { type: "activity" }>[];
  toolResults: Extract<Part, { type: "tool_result" }>[];
  approval: LiveApproval | null;
  retryNotice: string;
  stats: LiveStats;
  /** Stops the run (the user pressed Stop in the chat). */
  abort(): void;
};

/** What the runner reports into the store. Every method is safe to call after `end`. */
export type LiveRunHandle = {
  text(delta: string): void;
  toolResult(result: Extract<Part, { type: "tool_result" }>): void;
  activities(list: Extract<Part, { type: "activity" }>[]): void;
  retry(notice: string): void;
  /** A message of the run was stored: the step's live state is reset and views reload the chat. */
  message(role?: "user" | "assistant" | "tool"): void;
  /** Shows the request in the chat; the returned function removes it again. */
  approval(req: ApprovalRequest, answer: (ok: boolean, always?: boolean) => void): () => void;
  end(): void;
};

const runs = new Map<number, LiveRun[]>();
const versions = new Map<number, number>();
let chats: ReadonlySet<number> = new Set();
const listeners = new Set<() => void>();
const emit = () => {
  chats = new Set(runs.keys());
  listeners.forEach((l) => l());
};

export const subscribeLiveRuns = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The active live run of a chat (the latest when two schedules share a chat). Stable between changes. */
export const getLiveRun = (chatId: number | null): LiveRun | undefined => (chatId === null ? undefined : runs.get(chatId)?.slice(-1)[0]);
/** Changes whenever a message of a live run was stored in this chat or a live run ended. */
export const liveVersion = (chatId: number | null): number => (chatId === null ? 0 : versions.get(chatId) ?? 0);
/** Chats with an active live run (sidebar). */
export const getLiveChats = () => chats;

const bump = (chatId: number) => versions.set(chatId, liveVersion(chatId) + 1);

/** Registers a run in `chatId`. `abort` is what the chat's Stop button calls. */
export function beginLiveRun(chatId: number, title: string, abort: () => void): LiveRunHandle {
  let current: LiveRun = { chatId, title, stream: "", activities: [], toolResults: [], approval: null, retryNotice: "", stats: { start: Date.now(), chars: 0, input: 0 }, abort };
  const list = runs.get(chatId) ?? [];
  list.push(current);
  runs.set(chatId, list);
  bump(chatId);
  emit();
  let ended = false;
  /** Replaces the state object (new identity for useSyncExternalStore) while the run is active. */
  const set = (patch: Partial<LiveRun>) => {
    if (ended) return;
    const next = { ...current, ...patch };
    const l = runs.get(chatId);
    const at = l ? l.indexOf(current) : -1;
    if (l && at >= 0) l[at] = next;
    current = next;
    emit();
  };
  return {
    text: (delta) => set({ stream: current.stream + delta, retryNotice: "", stats: { ...current.stats, chars: current.stats.chars + delta.length } }),
    toolResult: (result) => set({ toolResults: [...current.toolResults.filter((r) => r.id !== result.id), result] }),
    activities: (list) => set({ activities: list }),
    retry: (notice) => set({ retryNotice: notice }),
    message: (role) => {
      if (ended) return;
      bump(chatId);
      set({ stream: "", activities: [], toolResults: role === "tool" ? [] : current.toolResults });
    },
    approval: (req, answer) => {
      const mine: LiveApproval = { req, resolve: answer };
      set({ approval: mine });
      return () => {
        if (current.approval === mine) set({ approval: null });
      };
    },
    end: () => {
      if (ended) return;
      ended = true;
      const l = (runs.get(chatId) ?? []).filter((r) => r !== current);
      if (l.length) runs.set(chatId, l);
      else runs.delete(chatId);
      bump(chatId);
      emit();
    },
  };
}
