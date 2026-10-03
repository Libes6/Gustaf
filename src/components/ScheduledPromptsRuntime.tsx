import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import { answerScheduledApproval, useScheduledApprovals } from "../lib/scheduledApprovals";
import { loadScheduled } from "../lib/scheduledPromptsStore";
import { startScheduledRuntime } from "../lib/scheduledRuntime";
import { useApp } from "../state";
import "../styles/scheduled.css";

/**
 * Mounted once (App): loads the schedules, starts the runner once the providers and models are known (it checks every
 * 30 seconds and when the window gets focus) and shows the approval requests of unattended runs. Renders nothing else.
 */
export function ScheduledPromptsRuntime() {
  const t = useT();
  const app = useApp();
  const approvals = useScheduledApprovals();
  const appRef = useRef(app);
  appRef.current = app;
  const ready = app.ready && app.onboarded && app.checkedAt > 0;

  useEffect(() => {
    if (!ready) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void loadScheduled().then(() => {
      if (!cancelled) stop = startScheduledRuntime(() => appRef.current);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [ready]);

  if (!approvals.length) return null;
  return (
    <div className="sched-approvals" role="region" aria-label={t("scheduledTitle")}>
      {approvals.map((a) => (
        <div className="sched-approval" key={a.id} role="alertdialog" aria-label={t("scheduledApprovalTitle", { title: a.title })}>
          <div className="t">{t("scheduledApprovalTitle", { title: a.title })}</div>
          <code className="sched-cmd">{a.command}</code>
          <div className="d">{t("scheduledApprovalHint")}</div>
          <div className="sched-actions">
            <button className="btn btn-primary" onClick={() => answerScheduledApproval(a.id, true)}>{t("scheduledAllowOnce")}</button>
            <button className="btn btn-ghost" onClick={() => answerScheduledApproval(a.id, false)}>{t("scheduledDeny")}</button>
            {a.chatId !== null && <button className="btn btn-ghost" onClick={() => app.openChat(a.chatId!, app.chats.find((c) => c.id === a.chatId)?.project_id ?? null)}>{t("scheduledOpenChat")}</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
