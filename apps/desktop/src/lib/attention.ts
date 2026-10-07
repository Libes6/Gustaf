import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "./api";
import { chatStatusStore, UNREAD_KEY } from "./chatStatus";
import { useAgentRuns } from "../agent/agentRuns";
import { isActiveStatus, type RunStatus } from "../agent/agentRunsModel";
import { getAgentSettings, loadAgentSettings } from "../agent/agentSettingsStore";
import { useT } from "../i18n";
import { isMuted } from "./mutedChats";

// What needs the user's attention outside the visible chat: pending approval requests per chat (the sidebar shows a badge
// on those chats) and, while the window is unfocused, a native notification (tauri-plugin-notification) plus the dock
// badge and a dock bounce when a background agent finishes, fails or waits for approval.

type Pending = { chatId: number | null; who: string };
const pending = new Map<number, Pending>();
let seq = 0;
let snapshot: ReadonlySet<number> = new Set();
const listeners = new Set<() => void>();
const emit = () => {
  snapshot = new Set([...pending.values()].map((p) => p.chatId).filter((id): id is number => id !== null));
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Registers an open approval request; call the returned function when it is answered. */
export function beginApproval(chatId: number | null | undefined, who: string): () => void {
  const id = ++seq;
  pending.set(id, { chatId: chatId ?? null, who });
  emit();
  return () => {
    if (pending.delete(id)) emit();
  };
}

/** Chats with an open approval request (main agent or a background subagent). */
export const useApprovalChats = () => useSyncExternalStore(subscribe, () => snapshot);

const inBrowser = () => typeof document !== "undefined" && typeof window !== "undefined";
const unfocused = () => inBrowser() && !document.hasFocus();

let unseen = 0;
async function setDock(count: number, bounce: boolean) {
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.setBadgeCount(count > 0 ? count : undefined);
    if (bounce) await w.requestUserAttention(UserAttentionType.Informational);
  } catch {
    /* not in Tauri, or the permission is missing */
  }
}

/** A native notification when the app is in the background (and notifications are on). */
export async function notifyUnfocused(title: string, body: string) {
  if (!unfocused()) return;
  await loadAgentSettings();
  if (!getAgentSettings().notifications) return;
  unseen++;
  void setDock(unseen, true);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:notification|notify", { options: { title, body } });
  } catch {
    /* the dock badge and bounce are the fallback */
  }
}

const NOTIFY: Partial<
  Record<RunStatus, "notifyAgentDone" | "notifyAgentFailed" | "notifyAgentLimit" | "notifyAgentBudget">
> = {
  completed: "notifyAgentDone",
  failed: "notifyAgentFailed",
  limit: "notifyAgentLimit",
  budget: "notifyAgentBudget",
};

/** Mounted once (App): notifies about finished agents and new approval requests while unfocused; clears the badge on focus. */
export function useAttentionNotifications() {
  const t = useT();
  const runs = useAgentRuns();
  const approvals = useApprovalChats();
  const statuses = useRef(new Map<string, RunStatus>());
  const asked = useRef(0);

  useEffect(() => {
    const known = statuses.current;
    for (const r of runs) {
      const before = known.get(r.id);
      known.set(r.id, r.status);
      const key = NOTIFY[r.status];
      // Only transitions seen in this session (not runs loaded from the last one); a stopped run needs no notice.
      if (before && isActiveStatus(before) && key)
        void notifyUnfocused(t(key, { title: r.title }), r.summary?.slice(0, 180) || r.error?.slice(0, 180) || r.model);
    }
  }, [runs, t]);

  useEffect(() => {
    // `seq` grows with every request: notify once per new request, naming who asks.
    if (seq <= asked.current) return;
    asked.current = seq;
    const last = pending.get(seq);
    if (last && !isMuted(last.chatId))
      void notifyUnfocused(t("notifyApproval"), t("notifyApprovalBody", { who: last.who || t("notifyMainAgent") }));
  }, [approvals, t]);

  useEffect(() => {
    if (!inBrowser()) return;
    const clear = () => {
      if (!unseen) return;
      unseen = 0;
      void setDock(0, false);
    };
    addEventListener("focus", clear);
    return () => removeEventListener("focus", clear);
  }, []);
}

/** Flags of the sidebar status badges: chats that finished unseen ("unread") and chats whose last run failed. */
export const useChatFlags = () => useSyncExternalStore(chatStatusStore.subscribe, chatStatusStore.get);

type NoticeT = (key: "notifyAgentDone" | "notifyAgentFailed", vars: { title: string }) => string;

/**
 * A chat run ended. Updates the sidebar flags; with `notify` and the window in the background it also raises the same
 * native notification and dock badge as a finished background agent (scheduled runs notify on their own).
 */
export function reportChatRun(
  chatId: number | null | undefined,
  outcome: "ok" | "failed" | "stopped",
  notify?: { title: string; detail?: string; t: NoticeT },
) {
  if (chatId == null) return;
  chatStatusStore.runEnded(chatId, outcome);
  if (notify && outcome !== "stopped" && !isMuted(chatId))
    void notifyUnfocused(
      notify.t(outcome === "ok" ? "notifyAgentDone" : "notifyAgentFailed", { title: notify.title }),
      (notify.detail ?? "").slice(0, 180),
    );
}

/** Mounted once (App): tells the status store which chat is in front (visible, window focused); restores and persists the unread ids. */
export function useChatStatusSync(activeChat: number | null, view: string) {
  const [focused, setFocused] = useState(() => !inBrowser() || document.hasFocus());
  useEffect(() => {
    if (!inBrowser()) return;
    const on = () => setFocused(true);
    const off = () => setFocused(false);
    addEventListener("focus", on);
    addEventListener("blur", off);
    return () => {
      removeEventListener("focus", on);
      removeEventListener("blur", off);
    };
  }, []);
  useEffect(() => {
    chatStatusStore.setViewing(view === "chat" && focused ? activeChat : null);
  }, [activeChat, view, focused]);
  useEffect(() => {
    let last = "[]";
    void getSetting<unknown>(UNREAD_KEY, [])
      .then((v) => chatStatusStore.load(v))
      .catch(() => {});
    return chatStatusStore.subscribe(() => {
      const now = JSON.stringify(chatStatusStore.unreadIds());
      if (now === last) return;
      last = now;
      void setSetting(UNREAD_KEY, JSON.parse(now)).catch(() => {});
    });
  }, []);
}
