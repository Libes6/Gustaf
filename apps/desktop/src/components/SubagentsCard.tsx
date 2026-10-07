import { Check, ChevronDown, ChevronRight, Loader2, Users, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { formatTokens } from "../agent/agentRunsModel";
import { useT } from "../i18n";
import type { Part, SubagentInfo } from "../providers/types";
import "../styles/agents.css";

export type SubagentActivity = Extract<Part, { type: "activity" }> & { subagent: SubagentInfo };
export const isSubagentActivity = (p: Part): p is SubagentActivity => p.type === "activity" && !!p.subagent;

/** Display state: an agent that was still running when the turn ended is "unknown" (the CLI never reported its result). */
export type ShownState = SubagentInfo["state"] | "unknown";
export const shownState = (a: SubagentActivity): ShownState => (a.status !== "running" && (a.subagent.state === "running" || a.subagent.state === "waiting") ? "unknown" : a.subagent.state);
export const agentTitle = (a: SubagentActivity, unnamed: (id: string) => string) => a.subagent.title || unnamed(a.subagent.agentId.slice(-6) || "…");

const STATE_KEY = { running: "subagentRunning", waiting: "subagentWaiting", completed: "subagentDone", failed: "subagentFailed", stopped: "subagentStopped", unknown: "subagentUnknown" } as const;
export const stateKey = (s: ShownState) => STATE_KEY[s];

function Row({ agent }: { agent: SubagentActivity }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const s = agent.subagent;
  const state = shownState(agent);
  const title = agentTitle(agent, (n) => t("subagentUnnamed", { id: n }));
  return (
    <li className="subagent-row">
      <button className="subagent-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <span className="subagent-title" title={title}>{title}</span>
        {s.role && <span className="subagent-role">{s.role}</span>}
        <span className={`subagent-chip ${state}`}>
          {state === "running" || state === "waiting" ? <Loader2 size={11} className="spin" aria-hidden="true" /> : state === "completed" ? <Check size={11} aria-hidden="true" /> : state === "failed" ? <X size={11} aria-hidden="true" /> : null}
          {t(stateKey(state))}
        </span>
      </button>
      {!open && (s.result || s.step) && <div className="subagent-result" title={s.result ?? s.step}>{s.result ?? s.step}</div>}
      {open && (
        <div id={id} className="subagent-detail" role="group" aria-label={title}>
          {s.prompt && <div><div className="subagent-label">{t("subagentTask")}</div><p>{s.prompt}</p></div>}
          {(s.waits || s.toolUses || s.tokens) ? (
            <div className="subagent-meta">
              {s.waits ? <span>{t("subagentWaits", { count: s.waits })}</span> : null}
              {s.toolUses ? <span>{t("agentsToolUses", { count: s.toolUses })}</span> : null}
              {s.tokens ? <span>{t("agentsTokens", { tokens: formatTokens(s.tokens) })}</span> : null}
            </div>
          ) : null}
          {s.step && (state === "running" || state === "waiting") && <div className="subagent-step">{s.step}</div>}
          {agent.output ? <div><div className="subagent-label">{t("agentsReport")}</div><pre className={state === "failed" ? "err" : ""}>{agent.output}</pre></div> : <p className="hint">{t("subagentNoResult")}</p>}
        </div>
      )}
    </li>
  );
}

/** One card for all subagents a CLI agent (Codex, Claude Code) started in a turn: counts, then one row per agent. */
export function SubagentsCard({ agents }: { agents: SubagentActivity[] }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const id = useId();
  const states = agents.map(shownState);
  const running = states.filter((s) => s === "running" || s === "waiting").length;
  const done = states.filter((s) => s === "completed").length;
  const failed = states.filter((s) => s === "failed").length;
  const stopped = states.filter((s) => s === "stopped" || s === "unknown").length;
  return (
    <section className="tool-card subagents-card" aria-label={t("subagentsTitle")}>
      <button className="tool-head" style={{ width: "100%" }} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <Users size={14} aria-hidden="true" />
        <span className="name">{t("subagentsTitle")}</span>
        <span className="arg">{t("subagentsSummary", { running, done })}{failed ? ` · ${t("subagentsFailedCount", { count: failed })}` : ""}{stopped ? ` · ${t("subagentsStoppedCount", { count: stopped })}` : ""}</span>
        {running > 0 ? <Loader2 size={13} className="spin" aria-hidden="true" /> : failed ? <X size={13} className="err" aria-hidden="true" /> : <Check size={13} color="var(--green)" aria-hidden="true" />}
      </button>
      {open && (
        <ul id={id} className="subagent-list" aria-label={t("subagentsTitle")}>
          {agents.map((a) => <Row key={a.id} agent={a} />)}
        </ul>
      )}
    </section>
  );
}

/** Replaces every subagent activity in `parts` by a single Subagents card at the position of the first one. */
export function renderWithSubagents<T extends Part>(parts: readonly T[], render: (p: T, i: number) => ReactNode): ReactNode[] {
  const agents = parts.filter(isSubagentActivity) as unknown as SubagentActivity[];
  let placed = false;
  return parts.map((p, i) => {
    if (!isSubagentActivity(p)) return render(p, i);
    if (placed) return null;
    placed = true;
    return <SubagentsCard key="subagents" agents={agents} />;
  });
}
