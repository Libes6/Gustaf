import { Bot, ChevronDown, ChevronRight, ChevronUp, Loader2, RotateCcw, Square, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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

type CardProps = {
  title: string;
  /** Muted type line under the title ("Agent · Explore"). */
  kind: string;
  /** Status chip of a finished agent. */
  status?: { label: string; tone: string };
  /** model · elapsed · tokens · tool uses */
  meta: string[];
  /** The line under the meta: the current step while running, the report start when finished. */
  step?: string;
  active: boolean;
  onOpen: () => void;
  onContinue?: () => void;
  stop?: { onClick: () => void; title: string };
  extra?: ReactNode;
};

/** One agent: bold title, muted type line, meta line, current step with the transcript link and a square stop button. */
function Card({ title, kind, status, meta, step, active, onOpen, onContinue, stop, extra }: CardProps) {
  const t = useT();
  return (
    <article className={`agent-card${active ? " running" : ""}`} aria-label={title}>
      <div className="agent-card-body">
        <div className="agent-card-title">
          <strong title={title}>{title}</strong>
          {status && <span className={`agent-status ${status.tone}`}>{status.label}</span>}
        </div>
        <div className="agent-card-kind">{kind}</div>
        <div className="agent-card-meta">{meta.map((m, i) => <span key={i} title={m}>{m}</span>)}</div>
        <div className="agent-card-step">
          {step ? <span className="step-text" title={step}>{step}</span> : <span className="step-text" />}
          <button className="link-btn" onClick={onOpen}>{t("agentsTranscript")}</button>
        </div>
        {extra}
        {onContinue && <div className="agent-card-actions"><button className="btn-soft" onClick={onContinue}><RotateCcw size={11} /> {t("agentsContinue")}</button></div>}
      </div>
      {active && stop && <button className="agent-stop" aria-label={t("stop")} title={stop.title} onClick={stop.onClick}><Square size={11} fill="currentColor" /></button>}
    </article>
  );
}

function Row({ run, now, onOpen, onContinue }: { run: AgentRun; now: number; onOpen: () => void; onContinue?: () => void }) {
  const t = useT();
  const active = isActiveStatus(run.status);
  const time = elapsed(run, now);
  const step = active ? (run.status === "queued" ? t("agentsWaiting") : run.currentStep || t("agentsThinking")) : run.summary ? run.summary.replace(/\s+/g, " ").trim() : undefined;
  return (
    <Card
      title={run.title}
      kind={t("agentsKind", { type: t(TYPE_KEY[run.type]) })}
      status={active ? undefined : { label: t(STATUS_KEY[run.status as keyof typeof STATUS_KEY]), tone: run.status }}
      meta={[run.model, ...(time ? [time] : []), t("agentsTokens", { tokens: formatTokens(run.tokens) }), t("agentsToolUses", { count: run.toolUses })]}
      step={step}
      active={active}
      onOpen={onOpen}
      onContinue={onContinue && canContinue(run.status) ? onContinue : undefined}
      stop={{ onClick: () => stopRun(run.id), title: t("stop") }}
      extra={(run.changed?.length || run.warnings?.length) ? (
        <>
          {run.changed?.length ? <div className="agent-card-note">{t("agentsChanged", { count: run.changed.length })}</div> : null}
          {run.warnings?.map((w, i) => <div key={i} className="agent-warn">{w}</div>)}
        </>
      ) : undefined}
    />
  );
}

function CliRow({ agent, now, onOpen }: { agent: CliAgent; now: number; onOpen: () => void }) {
  const t = useT();
  const active = isCliAgentActive(agent);
  const provider = t(PROVIDER_KEY[agent.provider]);
  const title = cliTitle(agent, (id) => t("subagentUnnamed", { id }));
  const time = elapsed({ status: active ? "running" : "completed", startedAt: agent.startedAt, endedAt: agent.endedAt }, now);
  const step = active ? agent.step || (agent.state === "waiting" ? t("subagentWaiting") : t("agentsThinking")) : agent.result;
  return (
    <Card
      title={title}
      kind={t("agentsKind", { type: provider })}
      status={active ? undefined : { label: t(CLI_STATE_KEY[agent.state]), tone: agent.state === "completed" ? "completed" : agent.state === "failed" ? "failed" : "cancelled" }}
      meta={[...(agent.role ? [agent.role] : []), ...(time ? [time] : []), ...(agent.toolUses > 0 ? [t("agentsToolUses", { count: agent.toolUses })] : [])]}
      step={step}
      active={active}
      onOpen={onOpen}
      stop={agent.stop ? { onClick: agent.stop, title: t("agentsStopCli", { provider }) } : undefined}
    />
  );
}

/**
 * "Background tasks": subagent runs of this project, running first, then a collapsible "Finished" list (see
 * agent/subagents.ts), plus the subagents Codex and Claude Code run inside their own CLI process (read-only, this
 * session only). `onContinue` receives the message that asks the main agent to continue a finished run (the chat puts
 * it in the composer).
 */
export function AgentsPanel({ root, onContinue }: { root: string | null; onContinue?: (message: string) => void }) {
  const t = useT();
  const runs = useAgentRuns(root);
  const cli = useCliAgents(root);
  const [open, setOpen] = useState(false);
  // Until the user toggles it, the finished list is open when nothing runs and folded away while something does.
  const [finishedOpen, setFinishedOpen] = useState<boolean | null>(null);
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
  const showFinished = finishedOpen ?? running === 0;
  const cards = (list: AgentRun[], cliList: CliAgent[]) => (
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
          {running > 0 && (
            <section aria-label={t("agentsRunning")}>
              <h3 className="agents-group">{t("agentsRunning")}</h3>
              {cards(active, cliActive)}
            </section>
          )}
          {finished > 0 && (
            <section aria-label={t("agentsFinished")}>
              <div className="agents-group">
                <button className="agents-group-toggle" aria-expanded={showFinished} onClick={() => setFinishedOpen(!showFinished)}>
                  {showFinished ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  {t("agentsFinishedCount", { count: finished })}
                </button>
                <button className="icon-btn" title={t("agentsClear")} aria-label={t("agentsClear")} onClick={() => { removeFinished(root ?? undefined); clearFinishedCliAgents(root ?? undefined); }}><Trash2 size={14} /></button>
              </div>
              {showFinished && cards(done, cliDone)}
            </section>
          )}
        </div>
      )}
      {viewed && viewing && <Transcript key={viewed.id} run={viewed} continuing={viewing.continuing} onContinue={onContinue} onClose={() => setViewing(null)} />}
      {viewedCli && <CliDetail key={viewedCli.key} agent={viewedCli} onClose={() => setViewingCli(null)} />}
    </aside>
  );
}
