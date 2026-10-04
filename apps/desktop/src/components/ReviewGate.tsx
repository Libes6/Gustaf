import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import type { GateFinding } from "../lib/autoReview";
import { MAX_REASON } from "../lib/autoReview";
import "../styles/diffReview.css";

/**
 * The confirm step before accepting or committing while automatic review has undismissed high-severity findings. It is a
 * warning, never a block: "continue anyway" always works. Each finding can be dismissed here, with an optional reason that
 * is kept with it for the session.
 */
export function ReviewGate({ findings, confirmLabel, onDismiss, onConfirm, onBack }: {
  findings: GateFinding[]; confirmLabel: string;
  onDismiss: (id: string, reason: string) => void; onConfirm: () => void; onBack: () => void;
}) {
  const t = useT();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  return (
    <div className="review-gate" role="alert">
      <div className="gate-title"><AlertTriangle size={14} /> <strong>{findings.length ? t("gateTitle", { count: findings.length }) : t("gateAllDismissed")}</strong></div>
      <ul>
        {findings.map((f) => (
          <li key={f.id}>
            <span className="gate-what"><code>{f.file}{f.line ? `:${f.line}` : ""}</code> {f.title}</span>
            <input className="input" maxLength={MAX_REASON} value={reasons[f.id] ?? ""} placeholder={t("gateReason")} aria-label={`${t("gateReason")}: ${f.title}`}
              onChange={(e) => setReasons((r) => ({ ...r, [f.id]: e.target.value }))} />
            <button className="btn-soft" aria-label={`${t("gateDismiss")}: ${f.title}`} onClick={() => onDismiss(f.id, reasons[f.id] ?? "")}>{t("gateDismiss")}</button>
          </li>
        ))}
      </ul>
      <div className="hint">{t("gateHint")}</div>
      <div className="gate-actions">
        <button className="btn btn-ghost" onClick={onBack}>{t("gateBack")}</button>
        <button className="btn btn-primary" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </div>
  );
}
