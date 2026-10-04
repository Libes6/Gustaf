import { Check, ChevronDown, ChevronRight, Loader2, Minus, ShieldCheck, X } from "lucide-react";
import { useId, useState } from "react";
import { useT, type Key } from "../i18n";
import type { Part } from "../providers/types";
import { GATE_ACTIVITY, OPEN_MODEL_PICKER_EVENT, readReport, type CheckResult, type CheckStatus, type GateReport } from "../agent/verificationCore";
import "../styles/verification.css";

/** True for the activity part a verification gate stores with the agent's message (docs/features/verification-gates.md). */
export const isVerificationPart = (p: Part): boolean => p.type === "activity" && p.name === GATE_ACTIVITY && !!readReport(p.args);

const STATUS_KEY: Record<CheckStatus, Key> = {
  passed: "verifStPassed", failed: "verifStFailed", timeout: "verifStTimeout", denied: "verifStDenied", declined: "verifStDeclined", skipped: "verifStSkipped", running: "verifStRunning",
};
const REASON_KEY = { max_attempts: "verifReasonMax", repeated: "verifReasonRepeated", blocked: "verifReasonBlocked", declined: "verifReasonDeclined" } as const;

const seconds = (ms: number) => (ms >= 1000 ?`${Math.round(ms / 100) / 10} s` : `${ms} ms`);

function Row({ check }: { check: CheckResult }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const ok = check.status === "passed";
  const bad = check.status !== "passed" && check.status !== "skipped" && check.status !== "running";
  return (
    <li className="verify-row">
      <button className="verify-row-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        {check.status === "running" ? <Loader2 size={12} className="spin" aria-hidden="true" /> : ok ? <Check size={12} color="var(--green)" aria-hidden="true" /> : bad ? <X size={12} className="err" aria-hidden="true" /> : <Minus size={12} aria-hidden="true" />}
        <span className="verify-name">{check.name}</span>
        <span className={`verify-st ${ok ? "ok" : bad ? "bad" : ""}`}>{t(STATUS_KEY[check.status])}</span>
        {check.durationMs > 0 && <span className="verify-time">{seconds(check.durationMs)}</span>}
      </button>
      {open && (
        <div id={id} className="verify-detail">
          <code>{check.command}</code>
          {check.output ? <pre className={bad ? "err" : ""}>{check.output}</pre> : <p className="hint">{t("verifNoOutput")}</p>}
        </div>
      )}
    </li>
  );
}

function headline(r: GateReport, t: ReturnType<typeof useT>) {
  if (r.outcome === "running") return t("verifRunning");
  if (r.outcome === "passed") return t("verifPassed", { count: r.results.filter((c) => c.status === "passed").length });
  if (r.outcome === "retry") return t("verifRetry", { n: r.attempt, max: r.maxFixAttempts });
  return t("verifFailed");
}

/** Compact "Verification" card of a turn: one row per required check (name, passed or failed, duration, expandable output). Styled like a tool card. */
export function VerificationCard({ part }: { part: Part }) {
  const t = useT();
  const report = readReport(part.type === "activity" ? part.args : null);
  const [open, setOpen] = useState(report?.outcome === "failed");
  const id = useId();
  if (!report) return null;
  const failed = report.outcome === "failed" || report.outcome === "retry";
  return (
    <section className="tool-card verify-card" aria-label={t("verifCardTitle")}>
      <button className="tool-head" style={{ width: "100%" }} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <ShieldCheck size={14} aria-hidden="true" />
        <span className="name">{t("verifCardTitle")}</span>
        <span className="arg">{headline(report, t)}</span>
        {report.outcome === "running" ? <Loader2 size={13} className="spin" aria-hidden="true" /> : failed ? <X size={13} className="err" aria-hidden="true" /> : <Check size={13} color="var(--green)" aria-hidden="true" />}
      </button>
      {open && (
        <div id={id}>
          <ul className="verify-list" aria-label={t("verifCardTitle")}>
            {report.results.map((c, i) => <Row key={`${c.name}-${i}`} check={c} />)}
          </ul>
          {report.outcome === "failed" && report.reason && <p className="verify-reason" role="note">{t(REASON_KEY[report.reason])}</p>}
        </div>
      )}
      {report.suggestion === "another_model" && (
        <div className="verify-suggest">
          <span>{t("verifTryModelHint")}</span>
          <button className="btn-soft" onClick={() => window.dispatchEvent(new Event(OPEN_MODEL_PICKER_EVENT))}>{t("verifTryModel")}</button>
        </div>
      )}
    </section>
  );
}
