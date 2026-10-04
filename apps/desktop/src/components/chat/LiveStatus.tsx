import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { ApprovalRequest } from "../../agent/agent";
import type { Part } from "../../providers/types";
import { Markdown } from "../Markdown";
import { LiveMeter, type LiveStats } from "../LiveMeter";
import { renderWithSubagents } from "../SubagentsCard";
import { ToolCard } from "../ToolCard";
import { isVerificationPart, VerificationCard } from "../VerificationCard";
import { ApprovalCard } from "./ApprovalCard";

type Approval = { req: ApprovalRequest; resolve: (ok: boolean, always?: boolean) => void } | null;

/** Tail of the feed while a run is active: running activities, streamed text or the "thinking" line (with the retry notice and LiveMeter), approval prompt. */
export function LiveStatus({ activities, stream, approval, retryNotice, stats, visible, onRunCommand, projectRoot }: {
  onRunCommand?: (command: string) => void;
  projectRoot?: string;
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
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{status}</div>
      {renderWithSubagents(activities, (a) => isVerificationPart(a) ? <VerificationCard key={a.id} part={a} /> : <ToolCard key={a.id} call={a} onRunCommand={onRunCommand} projectRoot={projectRoot} />)}
      {stream !== null &&
        (stream ? (
          <div className="msg-assistant caret">
            <Markdown text={stream} />
          </div>
        ) : (
          !approval && <div className="thinking"><span>{retryNotice || t("thinking")}</span> <LiveMeter stats={stats} /></div>
        ))}
      {stream && !approval && <div className="thinking"><LiveMeter stats={stats} /></div>}
      {approval && visible && <ApprovalCard req={approval.req} onAnswer={approval.resolve} />}
    </>
  );
}
