import { Bot, ChevronDown, ChevronUp, Loader2, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { loadRunSteps, removeFinished, stopRun, useAgentRuns } from "../agent/agentRuns";
import { elapsed, formatTokens, isActiveStatus, type AgentRun, type TranscriptStep } from "../agent/agentRunsModel";
import { canContinue, continueRequest } from "../agent/agentTranscript";
import { useDialogFocus } from "../lib/useDialogFocus";
import "../styles/agents.css";

const TYPE_KEY = { explore: "agentTypeExplore", plan: "agentTypePlan", general: "agentTypeGeneral", review: "agentTypeReview" } as const;
const STATUS_KEY = {
  completed: "agentsStatusCompleted",
  failed: "agentsStatusFailed",
  cancelled: "agentsStatusCancelled",
  limit: "agentsStatusLimit",
  budget: "agentsStatusBudget",
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

/** The full transcript is read from SQLite when the dialog opens (and every 2 s while the run is active). Falls back to the live steps in memory. */
function useSteps(run: AgentRun): TranscriptStep[] | null {
  const [steps, setSteps] = useState<TranscriptStep[] | null>(null);
  const active = isActiveStatus(run.status);
  useEffect(() => {
    let alive = true;
    const read = () => loadRunSteps(run.id).then((s) => { if (alive) setSteps(s); }).catch(() => { if (alive) setSteps((old) => old ?? []); });
    void read();
    if (!active) return () => { alive = false; };
    const id = setInterval(read, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [run.id, active]);
  return steps;
}

function Transcript({ run, continuing, onContinue, onClose }: { run: AgentRun; continuing: boolean; onContinue?: (prompt: string) => void; onClose: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef);
  const stored = useSteps(run);
  const steps = stored && stored.length ? stored : run.transcript;
  const [followUp, setFollowUp] = useState("");
  const canFollowUp = !!onContinue && canContinue(run.status);
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
          {stored === null && !steps.length && <div className="hint" role="status">{t("agentsLoadingSteps")}</div>}
          {stored !== null && !steps.length && <div className="hint">{t("agentsNoSteps")}</div>}
          {steps.map((s, i) => (
            <div key={i} className={`agent-step${s.error ? " bad" : ""}`}>
              <div className="agent-step-head">{s.kind === "tool" ? <><code>{s.tool}</code> <span>{s.text}</span></> : <span>{s.kind === "note" ? "·" : ""} {s.text}</span>}</div>
              {s.result && <pre>{s.result}</pre>}
            </div>
          ))}
          {canFollowUp && (
            <form
              className="agent-continue"
              onSubmit={(e) => { e.preventDefault(); if (followUp.trim()) { onContinue!(continueRequest(run, followUp)); onClose(); } }}
            >
              <textarea className="input" rows={3} value={followUp} autoFocus={continuing} onChange={(e) => setFollowUp(e.target.value)} placeholder={t("agentsContinuePlaceholder")} aria-label={t("agentsContinue")} />
              <div className="hint">{t("agentsContinueHint")}</div>
              <div><button type="submit" className="btn-soft" disabled={!followUp.trim()}><RotateCcw size={12} /> {t("agentsContinue")}</button></div>
            </form>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function Row({ run, now, onOpen, onContinue }: { run: AgentRun; now: number; onOpen: () => void; onContinue?: () => void }) {
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
        {onContinue && canContinue(run.status) && <button className="btn-soft" onClick={onContinue}><RotateCcw size={11} /> {t("agentsContinue")}</button>}
        <button className="btn-ghost small" onClick={onOpen}>{t("agentsTranscript")}</button>
      </div>
    </div>
  );
}

/**
 * "Background tasks": subagent runs of this project, running first, then finished (see agent/subagents.ts).
 * `onContinue` receives the message that asks the main agent to continue a finished run (the chat puts it in the composer).
 */
export function AgentsPanel({ root, onContinue }: { root: string | null; onContinue?: (message: string) => void }) {
  const t = useT();
  const runs = useAgentRuns(root);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; continuing: boolean } | null>(null);
  const active = runs.filter((r) => isActiveStatus(r.status));
  const done = runs.filter((r) => !isActiveStatus(r.status));
  const now = useNow(active.length > 0);
  // Open by itself when the first agent of a burst starts.
  useEffect(() => { if (active.length) setOpen(true); }, [active.length > 0]);
  if (!runs.length) return null;
  const viewed = viewing ? runs.find((r) => r.id === viewing.id) : undefined;
  const rows = (list: AgentRun[]) => list.map((r) => <Row key={r.id} run={r} now={now} onOpen={() => setViewing({ id: r.id, continuing: false })} onContinue={onContinue ? () => setViewing({ id: r.id, continuing: true }) : undefined} />);
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
          {rows(active)}
          {done.length > 0 && (
            <div className="agents-group">{t("agentsFinished")}<button className="btn-ghost small" onClick={() => removeFinished(root ?? undefined)}>{t("agentsClear")}</button></div>
          )}
          {rows(done)}
        </div>
      )}
      {viewed && viewing && <Transcript key={viewed.id} run={viewed} continuing={viewing.continuing} onContinue={onContinue} onClose={() => setViewing(null)} />}
    </aside>
  );
}
