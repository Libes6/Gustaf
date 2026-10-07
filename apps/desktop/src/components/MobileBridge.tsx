import { useEffect, useRef, useSyncExternalStore } from "react";
import { useApprovalChats, useChatFlags } from "../lib/attention";
import { deriveStatus } from "../lib/chatStatus";
import { getLiveChats, subscribeLiveRuns } from "../lib/liveRuns";
import { mobileServer, type MobileChatStatus } from "../lib/mobileServer";
import { useApp } from "../state";

/**
 * Renders nothing. Tells the mobile server (Rust) which chats are running, waiting for approval, failed or finished unseen,
 * with the same derivation as the sidebar badges (`deriveStatus`): the server cannot see session state, only the webview can.
 * Reports on every change and is harmless while the server is off.
 */
export function MobileStatusBridge() {
  const app = useApp();
  const waiting = useApprovalChats();
  const flags = useChatFlags();
  const live = useSyncExternalStore(subscribeLiveRuns, getLiveChats);
  const last = useRef("");
  const busy = app.sessions.items.filter((s) => s.busy && s.chatId !== null).map((s) => s.chatId as number);
  const busyKey = busy.join(",");

  useEffect(() => {
    const ids = new Set<number>([...busy, ...waiting, ...flags.failed, ...flags.unread, ...live]);
    const report: { chatId: number; status: MobileChatStatus }[] = [];
    for (const chatId of [...ids].sort((a, b) => a - b)) {
      const s = deriveStatus({
        waiting: waiting.has(chatId),
        running: live.has(chatId) || busy.includes(chatId),
        failed: flags.failed.has(chatId),
        unread: flags.unread.has(chatId),
      });
      if (s) report.push({ chatId, status: s === "unread" ? "done" : s });
    }
    const key = JSON.stringify(report);
    if (key === last.current) return;
    last.current = key;
    void mobileServer.reportStatus(report).catch(() => {});
  }, [busyKey, waiting, flags, live]);
  return null;
}
