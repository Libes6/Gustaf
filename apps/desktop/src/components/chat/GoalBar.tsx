import { Flag, Pause, Play, X } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { useT, type Key } from "../../i18n";
import { updateQueue } from "../../lib/chatQueue";
import { continuePrompt, isContinuation, resumeGoal } from "../../lib/goalCore";
import { getGoal, goalsVersion, loadGoal, setGoal, subscribeGoals } from "../../lib/goalStore";
import { useApp } from "../../state";

/**
 * The chat's goal above the composer: objective, status, turn count and tokens, with Pause / Resume / Clear.
 * Pausing or clearing also drops a continuation already waiting in the queue; Resume queues the next turn.
 */
export function GoalBar({ chatId, running }: { chatId: number | null; running: boolean }) {
  const t = useT();
  const app = useApp();
  useSyncExternalStore(subscribeGoals, goalsVersion);
  useEffect(() => {
    if (chatId) void loadGoal(chatId).catch(() => {});
  }, [chatId]);
  const goal = getGoal(chatId);
  if (!chatId || !goal) return null;
  const dropContinuations = () =>
    updateQueue(chatId, (q) => ({ ...q, items: q.items.filter((i) => !isContinuation(i.text)) }));
  const pause = () => {
    void setGoal(chatId, { ...goal, status: "paused", note: undefined });
    void dropContinuations();
  };
  const clear = () => {
    void setGoal(chatId, null);
    void dropContinuations();
  };
  const resume = () => {
    const next = resumeGoal(goal);
    void setGoal(chatId, next);
    if (!running)
      void updateQueue(chatId, (q) => ({
        ...q,
        paused: false,
        interrupted: false,
        items: [
          ...q.items.filter((i) => !isContinuation(i.text)),
          { id: crypto.randomUUID(), text: continuePrompt(next), images: [], clarify: false },
        ],
      }));
  };
  const note =
    goal.note &&
    (["stopped", "failed", "limit", "restart", "idle", "usage", "budget"].includes(goal.note)
      ? t(`goalNote_${goal.note}` as Key)
      : goal.note);
  return (
    <section className={`goal-bar goal-${goal.status}`} aria-label={t("goal")}>
      <Flag size={14} aria-hidden="true" className="goal-icon" />
      <div className="goal-main">
        <div className="goal-objective" title={goal.objective}>
          {goal.objective}
        </div>
        <div className="goal-meta" role="status">
          <span className="goal-status">{t(`goal_${goal.status}` as Key)}</span>
          {note && <span> · {note}</span>}
          {!goal.native && <span> · {t("goalTurns", { turns: goal.turns, max: goal.maxTurns })}</span>}
          {goal.tokens > 0 && <span> · {t("goalTokens", { tokens: goal.tokens.toLocaleString(app.locale) })}</span>}
        </div>
      </div>
      {goal.status === "active" ? (
        <button className="chip" onClick={pause}>
          <Pause size={12} aria-hidden="true" /> {t("goalPause")}
        </button>
      ) : goal.status !== "done" ? (
        <button className="chip" onClick={resume}>
          <Play size={12} aria-hidden="true" /> {t("goalResume")}
        </button>
      ) : null}
      <button className="icon-btn" title={t("goalClear")} aria-label={t("goalClear")} onClick={clear}>
        <X size={14} />
      </button>
    </section>
  );
}
