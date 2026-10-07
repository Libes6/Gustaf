import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ApprovalRequest } from "../../agent/agent";
import type { Part } from "../../providers/types";
import { Markdown } from "../Markdown";
import { LiveMeter, type LiveStats } from "../LiveMeter";
import { isSubagentActivity, SubagentsCard, type SubagentActivity } from "../SubagentsCard";
import { describeCall, ToolCard } from "../ToolCard";
import { ToolGroup } from "../ToolGroup";
import { groupRuns } from "../../lib/toolLabel";
import { isVerificationPart, VerificationCard } from "../VerificationCard";
import { ApprovalCard } from "./ApprovalCard";

type Approval = { req: ApprovalRequest; resolve: (ok: boolean, always?: boolean) => void } | null;

/** Tail of the feed while a run is active: running activities, streamed text or the "thinking" line (with the retry notice and LiveMeter), approval prompt. */
export function LiveStatus({ activities, stream, approval, retryNotice, stats, visible, onRunCommand, projectRoot, pendingCall }: {
  onRunCommand?: (command: string) => void;
  projectRoot?: string;
  /** A call of the running turn that has no result yet (API providers: its row is in the turn above); names the current action. */
  pendingCall?: Extract<Part, { type: "tool_call" }>;
  activities: Extract<Part, { type: "activity" }>[];
  stream: string | null;
  approval: Approval;
  retryNotice: string;
  stats: LiveStats;
  visible: boolean;
}) {
  const t = useT();
  // One polite announcement per state change (response started / finished, retry notice), never one per streamed token.
  const running = stream !== null;
  const wasRunning = useRef(running);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (running) setFinished(false);
    else if (wasRunning.current) setFinished(true);
    wasRunning.current = running;
  }, [running]);
  const status = retryNotice || (running ? t("announceResponding") : finished ? t("announceDone") : "");

  type Tool = Extract<Part, { type: "activity" }>;
  const agents = activities.filter(isSubagentActivity) as SubagentActivity[];
  const isTool = (a: Part) => a.type === "activity" && !isSubagentActivity(a) && !isVerificationPart(a);
  const runningTools = activities.filter((a) => isTool(a) && a.status === "running") as Tool[];
  const awaiting = approval ? runningTools[runningTools.length - 1]?.id : undefined;
  const row = (a: Tool) => <ToolCard key={a.id} call={a} awaitingApproval={a.id === awaiting} onRunCommand={onRunCommand} projectRoot={projectRoot} />;
  const renderActivities = () => {
    let placed = false;
    // Subagents become one card at the position of the first; the rest keep their order.
    const items = activities.filter((a) => !isSubagentActivity(a) || !placed && (placed = true));
    return groupRuns(items, isTool).map((g, gi) => {
      if ("item" in g) return isSubagentActivity(g.item) ? <SubagentsCard key="subagents" agents={agents} /> : isVerificationPart(g.item) ? <VerificationCard key={g.item.id} part={g.item} /> : null;
      const tools = g.tools as Tool[];
      return tools.length === 1 ? row(tools[0]) : <ToolGroup key={`g${gi}${tools[0].id}`} projectRoot={projectRoot} items={tools.map((call) => ({ call }))}>{tools.map(row)}</ToolGroup>;
    });
  };
  // What the model is doing right now: the running call, else "Thinking".
  const current = runningTools[runningTools.length - 1] ?? pendingCall;
  const action = current ? describeCall(t, current, true, projectRoot) : null;
  const working = action ? `${action.verb} ${action.target}`.trim() : "";
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</div>
      {renderActivities()}
      {stream !== null &&
        (stream ? (
          <div className="msg-assistant caret">
            <Markdown text={stream} />
          </div>
        ) : (
          !approval && <div className="thinking"><span title={working || undefined}>{retryNotice || working || t("thinking")}</span> <LiveMeter stats={stats} /></div>
        ))}
      {stream && !approval && <div className="thinking"><LiveMeter stats={stats} /></div>}
      {approval && visible && <ApprovalCard req={approval.req} onAnswer={approval.resolve} projectRoot={projectRoot} />}
    </>
  );
}
