import { useT } from "../../i18n";
import type { ApprovalRequest } from "../../agent/agent";
import type { Part } from "../../providers/types";
import { Markdown } from "../Markdown";
import { LiveMeter, type LiveStats } from "../LiveMeter";
import { ToolCard } from "../ToolCard";
import { ApprovalCard } from "./ApprovalCard";

type Approval = { req: ApprovalRequest; resolve: (ok: boolean, always?: boolean) => void } | null;

/** Tail of the feed while a run is active: running activities, streamed text or the "thinking" line (with the retry notice and LiveMeter), approval prompt. */
export function LiveStatus({ activities, stream, approval, retryNotice, stats, visible }: {
  activities: Extract<Part, { type: "activity" }>[];
  stream: string | null;
  approval: Approval;
  retryNotice: string;
  stats: LiveStats;
  visible: boolean;
}) {
  const t = useT();
  return (
    <>
      {activities.map((a) => <ToolCard key={a.id} call={a} />)}
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
