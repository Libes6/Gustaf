import { ChevronDown, ChevronRight, Copy, RotateCcw } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { useT } from "../../i18n";
import { userText, type Turn } from "../../lib/chatTurns";
import type { StoredMsg } from "../../lib/data";
import { textOf, type Part } from "../../providers/types";
import { Markdown } from "../Markdown";
import { ToolCard } from "../ToolCard";

// `focusId` is the message a search result points at: it is highlighted, and expanded if it sits in the collapsed steps.
export const TurnView = memo(function TurnView({ turn, live, liveResults, onRewind, focusId }: { turn: Turn; live: boolean; liveResults: Extract<Part, { type: "tool_result" }>[]; onRewind?: (m: StoredMsg) => void; focusId?: number | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const results = new Map([...turn.steps.flatMap((m) => m.parts).filter((p) => p.type === "tool_result"), ...(live ? liveResults : [])].map((p: any) => [p.id, p]));
  const assistants = turn.steps.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  const finalIsText = !!last && !last.parts.some((p) => p.type === "tool_call");
  const inner = finalIsText ? assistants.slice(0, -1) : assistants;
  const toolCount = inner.reduce((n, m) => n + m.parts.filter((p) => p.type === "tool_call").length, 0);
  const duration = last?.meta?.durationMs;
  const focusInSteps = focusId != null && inner.some((m) => m.id === focusId);
  useEffect(() => { if (focusInSteps) setOpen(true); }, [focusInSteps]);
  const expanded = open || focusInSteps || (live && !finalIsText);
  const hit = (m: StoredMsg) => (m.id === focusId ? " hit-flash" : "");

  const renderParts = (m: StoredMsg) =>
    m.parts.map((p, i) =>
      p.type === "text" ? (
        <div key={i} className="msg-assistant">
          <Markdown text={p.text} />
        </div>
      ) : p.type === "activity" ? (
        <ToolCard key={p.id} call={p} />
      ) : p.type === "tool_call" ? (
        <ToolCard key={p.id} call={p} result={results.get(p.id)} />
      ) : null,
    );

  return (
    <>
      {turn.user && userText(textOf(turn.user)) !== null && (
        <div className={`msg-block${hit(turn.user)}`} data-msg-id={turn.user.id}>
          <div className="msg-user">
            <div className="bubble">
              {turn.user.meta?.compacted && <strong className="summary-label">{t("contextSummary")}</strong>}
              {userText(textOf(turn.user))}
              {turn.user.parts.filter((p) => p.type === "image").map((p: any, i) => <img key={i} src={`data:image/png;base64,${p.data}`} alt="" />)}
            </div>
          </div>
          <div className="msg-actions" style={{ justifyContent: "flex-end", marginTop: -14 }}>
            <button className="icon-btn" title={t("copy")} onClick={() => navigator.clipboard.writeText(textOf(turn.user!))}>
              <Copy size={13} />
            </button>
            {onRewind && turn.user.meta?.checkpoint && (
              <button className="icon-btn" title={t("rewind")} onClick={() => onRewind(turn.user!)}>
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>
      )}
      {(toolCount > 0 || inner.some((m) => textOf(m))) && (
        <button className="done-line" style={{ width: "100%" }} onClick={() => setOpen(!expanded)}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {duration != null ? t("doneIn", { s: Math.max(1, Math.round(duration / 1000)) }) : t("steps", { count: toolCount })}
        </button>
      )}
      {expanded && <div className="msg-tools">{inner.map((m) => <div key={m.id} data-msg-id={m.id} className={m.id === focusId ? "hit-flash" : undefined}>{renderParts(m)}</div>)}</div>}
      {finalIsText && (
        <div className={`msg-block${hit(last)}`} data-msg-id={last.id}>
          {renderParts(last)}
          <div className="msg-actions">
            <button className="icon-btn" title={t("copy")} onClick={() => navigator.clipboard.writeText(textOf(last))}>
              <Copy size={13} />
            </button>
            {last.meta?.model && <span className="kbd" style={{ alignSelf: "center" }}>{last.meta.model}</span>}
          </div>
        </div>
      )}
    </>
  );
});
