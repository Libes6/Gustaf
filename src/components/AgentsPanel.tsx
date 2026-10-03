import { Bot, ChevronDown, ChevronUp, Loader2, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { removeFinished, stopRun, useAgentRuns } from "../agent/agentRuns";
import { elapsed, formatTokens, isActiveStatus, type AgentRun } from "../agent/agentRunsModel";
import { useDialogFocus } from "../lib/useDialogFocus";
import "../styles/agents.css";

const TYPE_KEY = { explore: "agentTypeExplore", plan: "agentTypePlan", general: "agentTypeGeneral", review: "agentTypeReview" } as const;
const STATUS_KEY = {
  completed: "agentsStatusCompleted",
  failed: "agentsStatusFailed",
  cancelled: "agentsStatusCancelled",
  limit: "agentsStatusLimit",
  interrupted: "agentsStatusInterrupted",
} as const;

/** Re-renders every second while something is running, so elapsed times tick. */
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Transcript({ run, onClose }: { run: AgentRun; onClose: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="review-dialog" role="dialog" aria-modal="true" aria-label={run.title}>
        <header>
          <strong>{run.title}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="agent-transcript">
          <div className="agent-meta">{t(TYPE_KEY[run.type])} · {run.model} · {t("agentsTokens", { tokens: formatTokens(run.tokens) })} · {t("agentsToolUses", { count: run.toolUses })}</div>
          {run.error && <div className="error-box" role="alert">{run.error}</div>}
          {run.warnings?.map((w, i) => <div key={i} className="agent-warn">{w}</div>)}
          {run.summary && <div className="agent-step"><div className="agent-step-head">{t("agentsReport")}</div><pre>{run.summary}</pre></div>}
          {!run.transcript.length && <div className="hint">{t("agentsNoSteps")}</div>}
          {run.transcript.map((s, i) => (
            <div key={i} className={`agent-step${s.error ? " bad" : ""}`}>
              <div className="agent-step-head">{s.kind === "tool" ? <><code>{s.tool}</code> <span>{s.text}</span></> : <span>{s.kind === "note" ? "·" : ""} {s.text}</span>}</div>
              {s.result && <pre>{s.result}</pre>}
            </div>
          ))}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function Row({ run, now, onOpen }: { run: AgentRun; now: number; onOpen: () => void }) {
  const t = useT();
  const active = isActiveStatus(run.status);
  const time = elapsed(run, now);
  return (
    <div className="agent-row">
      <div className="agent-line">
        <span className="agent-title" title={run.title}>{run.title}</span>
        <span className="agent-type">{t(TYPE_KEY[run.type])}</span>
        {!active && <span className={`agent-status ${run.status}`}>{t(STATUS_KEY[run.status as keyof typeof STATUS_KEY])}</span>}
      </div>
      <div className="agent-meta">
        <span title={run.model}>{run.model}</span>
        {time && <span>{time}</span>}
        <span>{t("agentsTokens", { tokens: formatTokens(run.tokens) })}</span>
        <span>{t("agentsToolUses", { count: run.toolUses })}</span>
      </div>
      {active && <div className="agent-step-line">{run.status === "queued" ? t("agentsWaiting") : run.currentStep || t("agentsThinking")}</div>}
      {run.changed?.length ? <div className="agent-meta">{t("agentsChanged", { count: run.changed.length })}</div> : null}
      {run.warnings?.map((w, i) => <div key={i} className="agent-warn">{w}</div>)}
      <div className="agent-actions">
        {active && <button className="btn-soft" onClick={() => stopRun(run.id)}><Square size={11} /> {t("stop")}</button>}
        <button className="btn-ghost small" onClick={onOpen}>{t("agentsTranscript")}</button>
      </div>
    </div>
  );
}

/** "Background tasks": subagent runs of this project, running first, then finished (see agent/subagents.ts). */
export function AgentsPanel({ root }: { root: string | null }) {
  const t = useT();
  const runs = useAgentRuns(root);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const active = runs.filter((r) => isActiveStatus(r.status));
  const done = runs.filter((r) => !isActiveStatus(r.status));
  const now = useNow(active.length > 0);
  // Open by itself when the first agent of a burst starts.
  useEffect(() => { if (active.length) setOpen(true); }, [active.length > 0]);
  if (!runs.length) return null;
  const viewed = runs.find((r) => r.id === viewing);
  return (
    <aside className={`agents-panel${open ? " open" : ""}`} aria-label={t("agentsTitle")}>
      <button className="agents-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {active.length ? <Loader2 size={14} className="spin" /> : <Bot size={14} />}
        <span className="grow">{t("agentsTitle")} · {t("agentsCount", { running: active.length, done: done.length })}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="agents-body">
          {active.length > 0 && <div className="agents-group">{t("agentsRunning")}</div>}
          {active.map((r) => <Row key={r.id} run={r} now={now} onOpen={() => setViewing(r.id)} />)}
          {done.length > 0 && (
            <div className="agents-group">{t("agentsFinished")}<button className="btn-ghost small" onClick={() => removeFinished(root ?? undefined)}>{t("agentsClear")}</button></div>
          )}
          {done.map((r) => <Row key={r.id} run={r} now={now} onOpen={() => setViewing(r.id)} />)}
        </div>
      )}
      {viewed && <Transcript run={viewed} onClose={() => setViewing(null)} />}
    </aside>
  );
}
