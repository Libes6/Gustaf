import { ChevronDown, ChevronRight, Copy, GitBranch, Pencil, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { userText, type Turn } from "../../lib/chatTurns";
import { editableText, turnActions } from "../../lib/messageActions";
import type { StoredMsg } from "../../lib/data";
import { textOf, type Part } from "../../providers/types";
import { extractPlan, type Plan } from "../../agent/planCore";
import { Markdown } from "../Markdown";
import { PlanCard } from "./PlanCard";
import { renderWithSubagents } from "../SubagentsCard";
import { ToolCard } from "../ToolCard";
import "../../styles/messageActions.css";

// `focusId` is the message a search result points at: it is highlighted, and expanded if it sits in the collapsed steps.
export type TurnHandlers = {
  onRunCommand?: (command: string) => void;
  diagnosticsProjectRoot?: string;
  /** Edit the user message and send the new text from there (history from that message on is replaced). */
  onEdit: (m: StoredMsg, text: string) => void;
  /** Re-run the turn of this user message. */
  onRegenerate: (user: StoredMsg) => void;
  /** Delete every message of the turn. */
  onDelete: (turn: Turn) => void;
  /** New chat with the history up to and including this message. */
  onBranch: (m: StoredMsg) => void;
  /** Approve a plan card: switch the chat to Agent mode and send the plan as the next instruction. */
  onApprovePlan: (plan: Plan) => void;
  /** Reject a plan card: stay in Plan mode and focus the composer for feedback. */
  onRejectPlan: () => void;
};

export const TurnView = memo(function TurnView({ turn, live, liveResults, onRewind, focusId, busy, isLastTurn, handlers }: { turn: Turn; live: boolean; liveResults: Extract<Part, { type: "tool_result" }>[]; onRewind?: (m: StoredMsg) => void; focusId?: number | null; busy: boolean; isLastTurn: boolean; handlers: TurnHandlers }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // Which delete button waits for its second click (the one under the user bubble or the one under the reply).
  const [confirming, setConfirming] = useState<"user" | "reply" | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);
  useEffect(() => { if (busy) { setEditing(null); setConfirming(null); } }, [busy]);
  const { show, enabled } = turnActions(turn, { busy, isLastTurn });
  const deleteBtn = (where: "user" | "reply") => show.remove && (
    <button
      className={`icon-btn${confirming === where ? " confirm" : ""}`}
      disabled={!enabled.remove}
      title={confirming === where ? t("deleteExchangeConfirm") : t("deleteExchange")}
      onClick={() => {
        clearTimeout(confirmTimer.current);
        if (confirming === where) { setConfirming(null); handlers.onDelete(turn); return; }
        setConfirming(where);
        confirmTimer.current = setTimeout(() => setConfirming(null), 3000);
      }}
    >
      {confirming === where ? t("delete") : <Trash2 size={13} />}
    </button>
  );
  const branchBtn = (m: StoredMsg) => show.branch && (
    <button className="icon-btn" disabled={!enabled.branch} title={t("branchFromHere")} onClick={() => handlers.onBranch(m)}>
      <GitBranch size={13} />
    </button>
  );
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

  const planActionable = isLastTurn && !busy;
  const renderParts = (m: StoredMsg) =>
    renderWithSubagents(m.parts, (p, i) =>
      p.type === "text" ? (
        <PlanOrMarkdown key={i} text={p.text} actionable={planActionable && m === last} handlers={handlers} />
      ) : p.type === "activity" ? (
        <ToolCard key={p.id} call={p} onRunCommand={handlers.onRunCommand} projectRoot={handlers.diagnosticsProjectRoot} />
      ) : p.type === "tool_call" ? (
        <ToolCard key={p.id} call={p} result={results.get(p.id)} onRunCommand={handlers.onRunCommand} projectRoot={handlers.diagnosticsProjectRoot} />
      ) : null,
    );

  const bodyText = turn.user ? userText(textOf(turn.user)) : null;
  const images = (turn.user?.parts.filter((p) => p.type === "image") ?? []) as Extract<Part, { type: "image" }>[];
  return (
    <>
      {turn.user && bodyText !== null && (
        <div className={`msg-block${hit(turn.user)}`} data-msg-id={turn.user.id}>
          {editing !== null ? (
            <div className="msg-edit">
              <textarea
                autoFocus
                aria-label={t("edit")}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editing.trim()) { handlers.onEdit(turn.user!, editing); setEditing(null); }
                }}
              />
              <div className="hint">{t("editResendHint")}</div>
              <div className="btns">
                <button className="btn btn-ghost" onClick={() => setEditing(null)}>{t("cancel")}</button>
                <button className="btn btn-primary" disabled={!enabled.edit || (!editing.trim() && !turn.user.parts.some((p) => p.type === "image"))} onClick={() => { handlers.onEdit(turn.user!, editing); setEditing(null); }}>{t("resend")}</button>
              </div>
            </div>
          ) : (
          <div className="msg-user">
            {images.length > 0 && (
              <div className="msg-images">
                {images.map((p, i) => <img key={i} src={`data:image/png;base64,${p.data}`} alt={t("sentImageAlt", { n: i + 1 })} />)}
              </div>
            )}
            {(bodyText || turn.user.meta?.compacted) && (
              <div className="bubble">
                {turn.user.meta?.compacted && <strong className="summary-label">{t("contextSummary")}</strong>}
                {bodyText}
              </div>
            )}
          </div>
          )}
          <div className={`msg-actions${confirming === "user" ? " pinned" : ""}`} style={{ justifyContent: "flex-end", marginTop: editing !== null ? 0 : -14 }}>
            <button className="icon-btn" title={t("copy")} onClick={() => navigator.clipboard.writeText(textOf(turn.user!))}>
              <Copy size={13} />
            </button>
            {onRewind && turn.user.meta?.checkpoint && (
              <button className="icon-btn" title={t("rewind")} onClick={() => onRewind(turn.user!)}>
                <RotateCcw size={13} />
              </button>
            )}
            {show.edit && editing === null && (
              <button className="icon-btn" disabled={!enabled.edit} title={t("editResend")} onClick={() => setEditing(editableText(turn.user!))}>
                <Pencil size={13} />
              </button>
            )}
            {branchBtn(turn.user)}
            {deleteBtn("user")}
          </div>
        </div>
      )}
      {(toolCount > 0 || inner.some((m) => textOf(m))) && (
        <button className="done-line" style={{ width: "100%" }} aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {duration != null ? t("doneIn", { s: Math.max(1, Math.round(duration / 1000)) }) : t("steps", { count: toolCount })}
        </button>
      )}
      {expanded && <div className="msg-tools">{inner.map((m) => <div key={m.id} data-msg-id={m.id} className={m.id === focusId ? "hit-flash" : undefined}>{renderParts(m)}</div>)}</div>}
      {finalIsText && (
        <div className={`msg-block${hit(last)}`} data-msg-id={last.id}>
          {renderParts(last)}
          <div className={`msg-actions${confirming === "reply" ? " pinned" : ""}`}>
            <button className="icon-btn" title={t("copy")} onClick={() => navigator.clipboard.writeText(textOf(last))}>
              <Copy size={13} />
            </button>
            {show.regenerate && (
              <button className="icon-btn" disabled={!enabled.regenerate} title={t("regenerate")} onClick={() => handlers.onRegenerate(turn.user!)}>
                <RefreshCw size={13} />
              </button>
            )}
            {branchBtn(last)}
            {deleteBtn("reply")}
            {last.meta?.model && <span className="kbd" style={{ alignSelf: "center" }}>{last.meta.model}</span>}
          </div>
        </div>
      )}
    </>
  );
});

/** An assistant text; a valid `mcode-plan` block in it becomes a plan card, anything unparsable stays Markdown. */
function PlanOrMarkdown({ text, actionable, handlers }: { text: string; actionable: boolean; handlers: TurnHandlers }) {
  const found = extractPlan(text);
  if (!found) return <div className="msg-assistant"><Markdown text={text} /></div>;
  return (
    <>
      {found.before.trim() && <div className="msg-assistant"><Markdown text={found.before} /></div>}
      <PlanCard plan={found.plan} actionable={actionable} onApprove={handlers.onApprovePlan} onReject={handlers.onRejectPlan} />
      {found.after.trim() && <div className="msg-assistant"><Markdown text={found.after} /></div>}
    </>
  );
}
