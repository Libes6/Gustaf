import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { useT, type Key } from "../i18n";
import { groupCounts, GROUP_ORDER, type GroupBucket } from "../lib/toolLabel";
import type { Part } from "../providers/types";
import { callStatus, describeCall } from "./ToolCard";

type Call = Extract<Part, { type: "tool_call" | "activity" }>;
type Result = Extract<Part, { type: "tool_result" }>;

/** One entry of a group: the call, its result when stored and the id/message it belongs to. */
export type GroupItem = { call: Call; result?: Result };

const COUNT_KEY: Record<GroupBucket, Key> = { command: "toolGroupCommands", read: "toolGroupReads", edit: "toolGroupEdits", search: "toolGroupSearches", other: "toolGroupOther" };

/** "Ran 6 commands · 2 files read" */
export function groupSummary(t: ReturnType<typeof useT>, calls: Call[]): string {
  const counts = groupCounts(calls);
  return GROUP_ORDER.filter((b) => counts[b]).map((b) => t(COUNT_KEY[b], { count: counts[b]! })).join(" · ");
}

/**
 * Consecutive tool calls of a turn folded into one collapsed line that expands to the rows. While a call runs the line
 * shows what it does; a failed call is counted in red. `children` are the rows (ToolCards).
 */
export function ToolGroup({ items, projectRoot, forceOpen, children }: { items: GroupItem[]; projectRoot?: string; forceOpen?: boolean; children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const shown = open || !!forceOpen;
  const statuses = items.map((i) => callStatus(i.call, i.result));
  const running = items.filter((_, n) => statuses[n] === "running");
  const failed = statuses.filter((s) => s === "error").length;
  const current = running.length ? running[running.length - 1] : null;
  const now = current ? describeCall(t, current.call, true, projectRoot) : null;
  return (
    <div className="tool-group">
      <button className="tool-group-head" aria-expanded={shown} aria-controls={id} onClick={() => setOpen(!shown)}>
        {shown ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        <span className="tool-group-summary">{groupSummary(t, items.map((i) => i.call))}</span>
        {failed > 0 && <span className="tool-group-failed">{t("toolGroupFailed", { count: failed })}</span>}
        {now && (
          <span className="tool-group-now" title={`${now.verb} ${now.target}`.trim()}>
            <Loader2 size={12} className="spin" aria-hidden="true" /> {now.verb} {now.target}
          </span>
        )}
      </button>
      {shown && <div id={id} className="tool-group-body">{children}</div>}
    </div>
  );
}
