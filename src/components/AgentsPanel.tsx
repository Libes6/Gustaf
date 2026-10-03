import { Bot, ChevronDown, ChevronUp, Loader2, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { loadRunSteps, removeFinished, stopRun, useAgentRuns } from "../agent/agentRuns";
import { clearFinishedCliAgents, isCliAgentActive, useCliAgents, type CliAgent } from "../agent/cliAgents";
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

const PROVIDER_KEY = { codex: "agentsProviderCodex", claude: "agentsProviderClaude" } as const;
const CLI_STATE_KEY = { running: "subagentRunning", waiting: "subagentWaiting", completed: "subagentDone", failed: "subagentFailed", ended: "subagentEnded" } as const;
const cliTitle = (a: CliAgent, unnamed: (id: string) => string) => a.title || unnamed(a.agentId.slice(-6) || "…");

/** Task and report of a CLI-native subagent (the CLI does not expose its transcript). */
function CliDetail({ agent, onClose }: { agent: CliAgent; onClose: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef);
  const title = cliTitle(agent, (id) => t("subagentUnnamed", { id }));
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, [onClose]);
  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="review-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <strong>{title}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose}><X size={17} /></button>
        </header>
        <div className="agent-transcript">
          <div className="agent-meta">{t(PROVIDER_KEY[agent.provider])} · {t(CLI_STATE_KEY[agent.state])}{agent.role ? ` · ${agent.role}` : ""}{agent.toolUses ? ` · ${t("agentsToolUses", { count: agent.toolUses })}` : ""}</div>
          <div className="hint">{t("agentsCliReadOnly", { provider: t(PROVIDER_KEY[agent.provider]) })}</div>
          {agent.prompt && <div className="agent-step"><div className="agent-step-head">{t("subagentTask")}</div><pre>{agent.prompt}</pre></div>}
          {agent.step && isCliAgentActive(agent) && <div className="agent-step"><div className="agent-step-head">{agent.step}</div></div>}
          {agent.output || agent.result ? <div className="agent-step"><div className="agent-step-head">{t("agentsReport")}</div><pre>{agent.output ?? agent.result}</pre></div> : <div className="hint">{t("subagentNoResult")}</div>}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function CliRow({ agent, now, onOpen }: { agent: CliAgent; now: number; onOpen: () => void }) {
  const t = useT();
  const active = isCliAgentActive(agent);
  const provider = t(PROVIDER_KEY[agent.provider]);
  const title = cliTitle(agent, (id) => t("subagentUnnamed", { id }));
  const time = elapsed({ status: active ? "running" : "completed", startedAt: agent.startedAt, endedAt: agent.endedAt }, now);
  return (
    <div className="agent-row">
      <div className="agent-line">
        <span className="agent-title" title={title}>{title}</span>
        <span className="agent-type">{provider}</span>
        {!active && <span className={`agent-status ${agent.state === "completed" ? "completed" : agent.state === "failed" ? "failed" : "cancelled"}`}>{t(CLI_STATE_KEY[agent.state])}</span>}
      </div>
      <div className="agent-meta">
        {agent.role && <span>{agent.role}</span>}
        {time && <span>{time}</span>}
        {agent.toolUses > 0 && <span>{t("agentsToolUses", { count: agent.toolUses })}</span>}
      </div>
      {active && <div className="agent-step-line">{agent.step || (agent.state === "waiting" ? t("subagentWaiting") : t("agentsThinking"))}</div>}
      {!active && agent.result && <div className="agent-step-line" title={agent.result}>{agent.result}</div>}
      <div className="agent-actions">
        {active && agent.stop && <button className="btn-soft" title={t("agentsStopCli", { provider })} onClick={agent.stop}><Square size={11} /> {t("stop")}</button>}
        <button className="btn-ghost small" onClick={onOpen}>{t("agentsTranscript")}</button>
      </div>
    </div>
  );
}

/**
 * "Background tasks": subagent runs of this project, running first, then finished (see agent/subagents.ts), plus the
 * subagents Codex and Claude Code run inside their own CLI process (read-only, this session only).
 * `onContinue` receives the message that asks the main agent to continue a finished run (the chat puts it in the composer).
 */
export function AgentsPanel({ root, onContinue }: { root: string | null; onContinue?: (message: string) => void }) {
  const t = useT();
  const runs = useAgentRuns(root);
  const cli = useCliAgents(root);
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<{ id: string; continuing: boolean } | null>(null);
  const [viewingCli, setViewingCli] = useState<string | null>(null);
  const active = runs.filter((r) => isActiveStatus(r.status));
  const done = runs.filter((r) => !isActiveStatus(r.status));
  const cliActive = cli.filter(isCliAgentActive);
  const cliDone = cli.filter((a) => !isCliAgentActive(a));
  const running = active.length + cliActive.length;
  const finished = done.length + cliDone.length;
  const now = useNow(running > 0);
  // Open by itself when the first agent of a burst starts.
  useEffect(() => { if (running) setOpen(true); }, [running > 0]);
  if (!runs.length && !cli.length) return null;
  const viewed = viewing ? runs.find((r) => r.id === viewing.id) : undefined;
  const viewedCli = viewingCli ? cli.find((a) => a.key === viewingCli) : undefined;
  const rows = (list: AgentRun[], cliList: CliAgent[]) => (
    <>
      {cliList.map((a) => <CliRow key={a.key} agent={a} now={now} onOpen={() => setViewingCli(a.key)} />)}
      {list.map((r) => <Row key={r.id} run={r} now={now} onOpen={() => setViewing({ id: r.id, continuing: false })} onContinue={onContinue ? () => setViewing({ id: r.id, continuing: true }) : undefined} />)}
    </>
  );
  return (
    <aside className={`agents-panel${open ? " open" : ""}`} aria-label={t("agentsTitle")}>
      <button className="agents-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {running ? <Loader2 size={14} className="spin" /> : <Bot size={14} />}
        <span className="grow">{t("agentsTitle")} · {t("agentsCount", { running, done: finished })}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="agents-body">
          {running > 0 && <div className="agents-group">{t("agentsRunning")}</div>}
          {rows(active, cliActive)}
          {finished > 0 && (
            <div className="agents-group">{t("agentsFinished")}<button className="btn-ghost small" onClick={() => { removeFinished(root ?? undefined); clearFinishedCliAgents(root ?? undefined); }}>{t("agentsClear")}</button></div>
          )}
          {rows(done, cliDone)}
        </div>
      )}
      {viewed && viewing && <Transcript key={viewed.id} run={viewed} continuing={viewing.continuing} onContinue={onContinue} onClose={() => setViewing(null)} />}
      {viewedCli && <CliDetail key={viewedCli.key} agent={viewedCli} onClose={() => setViewingCli(null)} />}
    </aside>
  );
}
