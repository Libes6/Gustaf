import { Eye, GitPullRequest, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useT, type Key } from "../../i18n";
import { allPassed } from "../../lib/prWatchCore";
import { clearPrWatch, getPrWatch, loadPrWatches, prWatchesVersion, stopPrWatch, subscribePrWatches } from "../../lib/prWatch";

/** The pull request this chat watches (`/watch`, T9): number, title and check summary, with Stop / Dismiss. */
export function PrWatchBar({ chatId }: { chatId: number | null }) {
  const t = useT();
  useSyncExternalStore(subscribePrWatches, prWatchesVersion);
  useEffect(() => { void loadPrWatches(); }, []);
  const w = getPrWatch(chatId);
  if (!chatId || !w) return null;
  const s = w.last;
  const failing = s?.checks.filter((c) => /FAILURE|ERROR|CANCELLED|TIMED_OUT|ACTION_REQUIRED/i.test(c.conclusion)).length ?? 0;
  const passed = s?.checks.filter((c) => /SUCCESS|NEUTRAL|SKIPPED/i.test(c.conclusion)).length ?? 0;
  const parts = [
    s && s.checks.length ? t("prWatchChecks", { passed, total: s.checks.length }) : "",
    failing ? t("prWatchFailing", { count: failing }) : "",
    s?.mergeable === "CONFLICTING" ? t("prWatchConflict") : "",
    w.stopped ? t(`prWatchStopped_${w.stopped.reason}` as Key) : "",
  ].filter(Boolean);
  return (
    <section className={`goal-bar pr-watch${w.stopped ? " stopped" : failing ? " failing" : s && allPassed(s) ? " passing" : ""}`} aria-label={t("prWatchTitle")}>
      {w.stopped ? <GitPullRequest size={14} aria-hidden="true" className="goal-icon" /> : <Eye size={14} aria-hidden="true" className="goal-icon" />}
      <div className="goal-main">
        <div className="goal-objective" title={s?.url}>{s ? `#${s.number} ${s.title}` : w.pr}</div>
        <div className="goal-meta" role="status">{t("prWatchTitle")}{parts.length ? ` · ${parts.join(" · ")}` : ""}</div>
      </div>
      {w.stopped
        ? <button className="icon-btn" title={t("prWatchDismiss")} aria-label={t("prWatchDismiss")} onClick={() => clearPrWatch(chatId)}><X size={14} /></button>
        : <button className="chip" onClick={() => stopPrWatch(chatId)}>{t("prWatchStop")}</button>}
    </section>
  );
}
