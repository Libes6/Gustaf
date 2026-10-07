import { pasteStats, splitComposerText } from "../../lib/chatContext";
import { useApp } from "../../state";
import { ChevronDown, ChevronRight, Copy, GitBranch, Pencil, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { useMenu } from "../Menu";
import { useT } from "../../i18n";
import { userText, type Turn } from "../../lib/chatTurns";
import { editableText, turnActions } from "../../lib/messageActions";
import type { StoredMsg } from "../../lib/data";
import { textOf, type Part } from "../../providers/types";
import { extractPlan, type Plan } from "../../agent/planCore";
import { Markdown } from "../Markdown";
import { ImageThumb } from "../ImageViewer";
import { PlanCard } from "./PlanCard";
import { isSubagentActivity, renderWithSubagents, SubagentsCard, type SubagentActivity } from "../SubagentsCard";
import { ToolCard } from "../ToolCard";
import { ToolGroup } from "../ToolGroup";
import { groupRuns } from "../../lib/toolLabel";
import { isVerificationPart, VerificationCard } from "../VerificationCard";
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

export const TurnView = memo(function TurnView({
  turn,
  live,
  liveResults,
  onRewind,
  focusId,
  busy,
  isLastTurn,
  handlers,
  approving,
}: {
  turn: Turn;
  live: boolean;
  liveResults: Extract<Part, { type: "tool_result" }>[];
  onRewind?: (m: StoredMsg, o: { files: boolean }) => void;
  focusId?: number | null;
  busy: boolean;
  isLastTurn: boolean;
  handlers: TurnHandlers;
  /** An approval card is open: the call that is still running waits for it. */ approving?: boolean;
}) {
  const t = useT();
  const rewindMenu = useMenu();
  const app = useApp();
  const userContext = splitComposerText(turn.user ? textOf(turn.user) : "");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // Which delete button waits for its second click (the one under the user bubble or the one under the reply).
  const [confirming, setConfirming] = useState<"user" | "reply" | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);
  useEffect(() => {
    if (busy) {
      setEditing(null);
      setConfirming(null);
    }
  }, [busy]);
  const { show, enabled } = turnActions(turn, { busy, isLastTurn });
  const deleteBtn = (where: "user" | "reply") =>
    show.remove && (
      <button
        className={`icon-btn${confirming === where ? " confirm" : ""}`}
        disabled={!enabled.remove}
        title={confirming === where ? t("deleteExchangeConfirm") : t("deleteExchange")}
        onClick={() => {
          clearTimeout(confirmTimer.current);
          if (confirming === where) {
            setConfirming(null);
            handlers.onDelete(turn);
            return;
          }
          setConfirming(where);
          confirmTimer.current = setTimeout(() => setConfirming(null), 3000);
        }}
      >
        {confirming === where ? t("delete") : <Trash2 size={13} />}
      </button>
    );
  const branchBtn = (m: StoredMsg) =>
    show.branch && (
      <button
        className="icon-btn"
        disabled={!enabled.branch}
        title={t("branchFromHere")}
        onClick={() => handlers.onBranch(m)}
      >
        <GitBranch size={13} />
      </button>
    );
  const results = new Map(
    [...turn.steps.flatMap((m) => m.parts).filter((p) => p.type === "tool_result"), ...(live ? liveResults : [])].map(
      (p: any) => [p.id, p],
    ),
  );
  const assistants = turn.steps.filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  const finalIsText = !!last && !last.parts.some((p) => p.type === "tool_call");
  const inner = finalIsText ? assistants.slice(0, -1) : assistants;
  const toolCount = inner.reduce((n, m) => n + m.parts.filter((p) => p.type === "tool_call").length, 0);
  const duration = last?.meta?.durationMs;
  const focusInSteps = focusId != null && inner.some((m) => m.id === focusId);
  useEffect(() => {
    if (focusInSteps) setOpen(true);
  }, [focusInSteps]);
  const expanded = open || focusInSteps || (live && !finalIsText);
  const hit = (m: StoredMsg) => (m.id === focusId ? " hit-flash" : "");

  // When each call and its result were stored: the difference is the duration shown on hover.
  const storedAt = new Map<string, { call?: number; result?: number }>();
  for (const m of turn.steps)
    for (const p of m.parts) {
      if (p.type === "tool_call") storedAt.set(p.id, { ...storedAt.get(p.id), call: m.created_at });
      else if (p.type === "tool_result") storedAt.set(p.id, { ...storedAt.get(p.id), result: m.created_at });
    }
  const durationOf = (id: string) => {
    const a = storedAt.get(id);
    return a?.call != null && a.result != null && a.result > a.call ? a.result - a.call : undefined;
  };
  const pendingIds = inner.flatMap((m) =>
    m.parts.filter((p) => p.type === "tool_call" && !results.has(p.id)).map((p: any) => p.id as string),
  );
  const awaitingId = live && approving ? pendingIds[pendingIds.length - 1] : undefined;

  const planActionable = isLastTurn && !busy;
  const renderParts = (m: StoredMsg) =>
    renderWithSubagents(m.parts, (p, i) =>
      p.type === "text" ? (
        <PlanOrMarkdown key={i} text={p.text} actionable={planActionable && m === last} handlers={handlers} />
      ) : isVerificationPart(p) ? (
        <VerificationCard key={`verification-${i}`} part={p} />
      ) : p.type === "activity" ? (
        <ToolCard
          key={p.id}
          call={p}
          at={m.created_at}
          onRunCommand={handlers.onRunCommand}
          projectRoot={handlers.diagnosticsProjectRoot}
        />
      ) : p.type === "tool_call" ? (
        <ToolCard
          key={p.id}
          call={p}
          at={m.created_at}
          result={results.get(p.id)}
          durationMs={durationOf(p.id)}
          onRunCommand={handlers.onRunCommand}
          projectRoot={handlers.diagnosticsProjectRoot}
        />
      ) : null,
    );

  // The steps before the final reply: text and cards in order, with consecutive tool calls folded into one group.
  type Node =
    | { m: StoredMsg; kind: "tool"; p: Extract<Part, { type: "tool_call" | "activity" }>; i: number }
    | { m: StoredMsg; kind: "agents"; agents: SubagentActivity[] }
    | { m: StoredMsg; kind: "other"; p: Part; i: number };
  const nodes: Node[] = inner.flatMap((m): Node[] => {
    const agents = m.parts.filter(isSubagentActivity) as SubagentActivity[];
    let placed = false;
    return m.parts.flatMap((p, i): Node[] => {
      if (isSubagentActivity(p)) {
        if (placed) return [];
        placed = true;
        return [{ m, kind: "agents", agents }];
      }
      if (p.type === "tool_result" || (p.type === "text" && !p.text.trim())) return [];
      if ((p.type === "tool_call" || p.type === "activity") && !isVerificationPart(p))
        return [{ m, kind: "tool", p, i }];
      return [{ m, kind: "other", p, i }];
    });
  });
  const wrap = (m: StoredMsg, key: string, child: React.ReactNode) => (
    <div key={key} data-msg-id={m.id} className={m.id === focusId ? "hit-flash" : undefined}>
      {child}
    </div>
  );
  const toolRow = (n: Extract<Node, { kind: "tool" }>) => (
    <ToolCard
      key={n.p.id}
      call={n.p}
      at={n.m.created_at}
      result={n.p.type === "tool_call" ? results.get(n.p.id) : undefined}
      durationMs={n.p.type === "tool_call" ? durationOf(n.p.id) : undefined}
      awaitingApproval={n.p.id === awaitingId}
      onRunCommand={handlers.onRunCommand}
      projectRoot={handlers.diagnosticsProjectRoot}
    />
  );
  const renderSteps = () =>
    groupRuns(nodes, (n) => n.kind === "tool").map((g, gi) => {
      if ("item" in g) {
        const n = g.item;
        if (n.kind === "agents") return wrap(n.m, `a${n.m.id}`, <SubagentsCard agents={n.agents} />);
        if (n.kind === "other")
          return wrap(n.m, `${n.m.id}:${n.i}`, renderParts({ ...n.m, parts: [n.p] } as StoredMsg));
        return null;
      }
      const tools = g.tools as Extract<Node, { kind: "tool" }>[];
      if (tools.length === 1) return wrap(tools[0].m, `${tools[0].m.id}:${tools[0].i}`, toolRow(tools[0]));
      return (
        <ToolGroup
          key={`g${gi}${tools[0].p.id}`}
          projectRoot={handlers.diagnosticsProjectRoot}
          forceOpen={tools.some((n) => n.m.id === focusId)}
          items={tools.map((n) => ({ call: n.p, result: n.p.type === "tool_call" ? results.get(n.p.id) : undefined }))}
        >
          {tools.map((n) => wrap(n.m, `${n.m.id}:${n.i}`, toolRow(n)))}
        </ToolGroup>
      );
    });

  const bodyText = turn.user ? userText(textOf(turn.user)) : null;
  const contextText = turn.user ? userText(userContext.body) : null;
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
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && editing.trim()) {
                    handlers.onEdit(turn.user!, editing);
                    setEditing(null);
                  }
                }}
              />
              <div className="hint">{t("editResendHint")}</div>
              <div className="btns">
                <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                  {t("cancel")}
                </button>
                <button
                  className="btn btn-primary"
                  disabled={!enabled.edit || (!editing.trim() && !turn.user.parts.some((p) => p.type === "image"))}
                  onClick={() => {
                    handlers.onEdit(turn.user!, editing);
                    setEditing(null);
                  }}
                >
                  {t("resend")}
                </button>
              </div>
            </div>
          ) : (
            <div className="msg-user">
              {images.length > 0 && (
                <div className="msg-images">
                  {images.map((p, i) => (
                    <ImageThumb
                      key={i}
                      src={`data:image/png;base64,${p.data}`}
                      alt={t("attachedImage", { n: i + 1, total: images.length })}
                    />
                  ))}
                </div>
              )}
              {(contextText ||
                userContext.references.length > 0 ||
                userContext.pastes.length > 0 ||
                turn.user.meta?.compacted) && (
                <div className="bubble">
                  {turn.user.meta?.compacted && <strong className="summary-label">{t("contextSummary")}</strong>}
                  {contextText}
                  {userContext.pastes.map((paste, i) => {
                    const { lines, chars } = pasteStats(paste);
                    return (
                      <div className="chat-reference paste-card" key={`paste:${i}`}>
                        <strong>{t("pastedText")}</strong>{" "}
                        <span>
                          {t("pastedTextStats", {
                            lines: lines.toLocaleString(app.locale),
                            chars: chars.toLocaleString(app.locale),
                          })}
                        </span>
                        <details>
                          <summary>{t("pastedTextShow")}</summary>
                          <pre>{paste.text}</pre>
                        </details>
                      </div>
                    );
                  })}
                  {userContext.references.map((ref, i) => (
                    <div className="chat-reference" key={`${ref.sourceId}:${i}`}>
                      <button
                        className="btn-ghost"
                        disabled={!app.chats.some((c) => c.id === ref.sourceId)}
                        onClick={() =>
                          app.openChat(ref.sourceId, app.chats.find((c) => c.id === ref.sourceId)?.project_id ?? null)
                        }
                      >
                        {ref.title}
                      </button>
                      <span>
                        {ref.snapshot.length.toLocaleString()}{" "}
                        {app.locale === "ru" ? "символов · справочный материал" : "characters · reference material"}
                      </span>
                      <details>
                        <summary>{app.locale === "ru" ? "Отправленный снимок" : "Sent snapshot"}</summary>
                        <pre>{ref.snapshot}</pre>
                      </details>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div
            className={`msg-actions${confirming === "user" ? " pinned" : ""}`}
            style={{ justifyContent: "flex-end", marginTop: editing !== null ? 0 : -14 }}
          >
            <button
              className="icon-btn"
              title={t("copy")}
              onClick={() => navigator.clipboard.writeText(textOf(turn.user!))}
            >
              <Copy size={13} />
            </button>
            {onRewind && (
              <button
                className="icon-btn"
                title={t("rewind")}
                aria-label={t("rewind")}
                aria-haspopup="menu"
                disabled={busy}
                onClick={(e) =>
                  rewindMenu.open(e.currentTarget.getBoundingClientRect(), [
                    {
                      label: t("rewindKeepFiles"),
                      description: t("rewindKeepFilesHint"),
                      onClick: () => onRewind(turn.user!, { files: false }),
                    },
                    ...(turn.user!.meta?.checkpoint
                      ? [
                          {
                            label: t("rewindWithFiles"),
                            description: t("rewindWithFilesHint"),
                            onClick: () => onRewind(turn.user!, { files: true }),
                          },
                        ]
                      : []),
                  ])
                }
              >
                <RotateCcw size={13} />
              </button>
            )}
            {show.edit && editing === null && (
              <button
                className="icon-btn"
                disabled={!enabled.edit}
                title={t("editResend")}
                onClick={() => setEditing(editableText(turn.user!))}
              >
                <Pencil size={13} />
              </button>
            )}
            {branchBtn(turn.user)}
            {deleteBtn("user")}
          </div>
        </div>
      )}
      {(toolCount > 0 || inner.some((m) => textOf(m))) && (
        <button
          className="done-line"
          style={{ width: "100%" }}
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {duration != null
            ? t("doneIn", { s: Math.max(1, Math.round(duration / 1000)) })
            : t("steps", { count: toolCount })}
        </button>
      )}
      {expanded && <div className="msg-tools">{renderSteps()}</div>}
      {finalIsText && (
        <div className={`msg-block${hit(last)}`} data-msg-id={last.id}>
          {renderParts(last)}
          <div className={`msg-actions${confirming === "reply" ? " pinned" : ""}`}>
            <button className="icon-btn" title={t("copy")} onClick={() => navigator.clipboard.writeText(textOf(last))}>
              <Copy size={13} />
            </button>
            {show.regenerate && (
              <button
                className="icon-btn"
                disabled={!enabled.regenerate}
                title={t("regenerate")}
                onClick={() => handlers.onRegenerate(turn.user!)}
              >
                <RefreshCw size={13} />
              </button>
            )}
            {branchBtn(last)}
            {deleteBtn("reply")}
            {last.meta?.model && (
              <span className="kbd" style={{ alignSelf: "center" }}>
                {last.meta.model}
              </span>
            )}
          </div>
        </div>
      )}
      {rewindMenu.node}
    </>
  );
});

/** An assistant text; a valid `gustaf-plan` block in it becomes a plan card, anything unparsable stays Markdown. */
function PlanOrMarkdown({ text, actionable, handlers }: { text: string; actionable: boolean; handlers: TurnHandlers }) {
  const found = extractPlan(text);
  if (!found)
    return (
      <div className="msg-assistant">
        <Markdown text={text} />
      </div>
    );
  return (
    <>
      {found.before.trim() && (
        <div className="msg-assistant">
          <Markdown text={found.before} />
        </div>
      )}
      <PlanCard
        plan={found.plan}
        actionable={actionable}
        onApprove={handlers.onApprovePlan}
        onReject={handlers.onRejectPlan}
      />
      {found.after.trim() && (
        <div className="msg-assistant">
          <Markdown text={found.after} />
        </div>
      )}
    </>
  );
}
