import { ArrowDown, ArrowUp, Check, ListChecks, Plus, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../../i18n";
import { normalizePlan, type Plan } from "../../agent/planCore";
import "../../styles/plan.css";

type Props = {
  plan: Plan;
  /** Approve is only offered on the latest plan of an idle chat. */
  actionable: boolean;
  onApprove: (plan: Plan) => void;
  onReject: () => void;
};

/** A finished plan as a checklist card: Approve (optionally after editing the steps inline) or Reject. */
export function PlanCard({ plan, actionable, onApprove, onReject }: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Plan>(plan);
  const shown = editing ? draft : plan;
  const setStep = (i: number, text: string) => setDraft({ ...draft, steps: draft.steps.map((s, k) => (k === i ? { ...s, text } : s)) });
  const move = (i: number, d: number) => {
    const steps = [...draft.steps];
    [steps[i], steps[i + d]] = [steps[i + d], steps[i]];
    setDraft({ ...draft, steps });
  };
  const finish = () => {
    // Empty steps are dropped and ids renumbered; a plan with no step left cannot be approved.
    const clean = normalizePlan(draft);
    if (!clean) return null;
    setDraft(clean);
    return clean;
  };
  return (
    <section className="plan-card" aria-label={t("planCardLabel")}>
      <header>
        <ListChecks size={15} aria-hidden />
        {editing ? (
          <input className="plan-title" aria-label={t("planTitleLabel")} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        ) : (
          <strong>{plan.title}</strong>
        )}
      </header>
      <ol aria-label={t("planSteps")}>
        {shown.steps.map((s, i) => (
          <li key={editing ? i : s.id}>
            {editing ? (
              <>
                <input aria-label={t("planStepLabel", { n: i + 1 })} value={s.text} onChange={(e) => setStep(i, e.target.value)} />
                <button className="icon-btn" disabled={i === 0} title={t("planMoveUp", { n: i + 1 })} aria-label={t("planMoveUp", { n: i + 1 })} onClick={() => move(i, -1)}><ArrowUp size={13} /></button>
                <button className="icon-btn" disabled={i === draft.steps.length - 1} title={t("planMoveDown", { n: i + 1 })} aria-label={t("planMoveDown", { n: i + 1 })} onClick={() => move(i, 1)}><ArrowDown size={13} /></button>
                <button className="icon-btn" title={t("planRemoveStep", { n: i + 1 })} aria-label={t("planRemoveStep", { n: i + 1 })} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, k) => k !== i) })}><X size={13} /></button>
              </>
            ) : (
              <span>
                {s.text}
                {s.files?.length ? <code className="plan-files">{s.files.join(", ")}</code> : null}
              </span>
            )}
          </li>
        ))}
      </ol>
      {editing && (
        <button className="btn-soft" onClick={() => setDraft({ ...draft, steps: [...draft.steps, { id: String(draft.steps.length + 1), text: "" }] })}>
          <Plus size={13} /> {t("planAddStep")}
        </button>
      )}
      {!editing && shown.risks?.length ? (
        <div className="plan-extra"><strong>{t("planRisks")}</strong><ul>{shown.risks.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
      ) : null}
      {!editing && shown.questions?.length ? (
        <div className="plan-extra"><strong>{t("planQuestions")}</strong><ul>{shown.questions.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
      ) : null}
      {actionable && (
        <footer>
          {editing ? (
            <>
              <button className="btn btn-ghost" onClick={() => (setDraft(plan), setEditing(false))}>{t("cancel")}</button>
              <button className="btn btn-ghost" disabled={!normalizePlan(draft)} onClick={() => finish() && setEditing(false)}>{t("planEditDone")}</button>
              <button className="btn btn-primary" disabled={!normalizePlan(draft)} onClick={() => { const c = finish(); if (c) onApprove(c); }}><Check size={13} /> {t("planApprove")}</button>
            </>
          ) : (
            <>
              <span className="hint">{t("planApproveNote")}</span>
              <button className="btn btn-ghost" onClick={onReject}>{t("planReject")}</button>
              <button className="btn btn-ghost" onClick={() => (setDraft(plan), setEditing(true))}>{t("planEdit")}</button>
              <button className="btn btn-primary" onClick={() => onApprove(plan)}><Check size={13} /> {t("planApprove")}</button>
            </>
          )}
        </footer>
      )}
    </section>
  );
}
