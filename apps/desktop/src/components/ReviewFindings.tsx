import { ChevronDown, ChevronRight, MessageSquarePlus, Send, X } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n";
import { MAX_COMMENT, sortFindings, type FeedbackComment, type Finding } from "../lib/diffReview";
import "../styles/diffReview.css";

export type NewComment = Omit<FeedbackComment, "id">;
const SEVERITY_KEY = { bug: "findingBug", warn: "findingWarn", info: "findingInfo" } as const;

/** One finding of the AI review: severity chip, title, collapsible detail, and Reply / Dismiss. Nothing here changes any file. */
export function FindingCard({ finding: f, onDismiss, onReply }: { finding: Finding; onDismiss: (id: string) => void; onReply?: (f: Finding) => void }) {
  const t = useT();
  const [open, setOpen] = useState(f.severity === "bug");
  return (
    <div className={`finding sev-${f.severity}`} role="group" aria-label={`${t(SEVERITY_KEY[f.severity])}: ${f.title}`}>
      <div className="finding-head">
        <button className="finding-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span className="chip">{t(SEVERITY_KEY[f.severity])}</span>
          <span className="finding-title">{f.title}</span>
          {f.line ? <span className="hint">:{f.line}</span> : null}
        </button>
        {onReply && <button className="icon-btn" title={t("findingReply")} aria-label={`${t("findingReply")}: ${f.title}`} onClick={() => onReply(f)}><MessageSquarePlus size={14} /></button>}
        <button className="icon-btn" title={t("findingDismiss")} aria-label={`${t("findingDismiss")}: ${f.title}`} onClick={() => onDismiss(f.id)}><X size={14} /></button>
      </div>
      {open && <div className="finding-body">
        <p>{f.detail}</p>
        {f.suggestion && <p><strong>{t("findingSuggestion")}</strong> {f.suggestion}</p>}
      </div>}
    </div>
  );
}

/** A small comment form; the text is kept by the parent only after "Add comment". */
export function CommentBox({ label, context, onSave, onCancel }: { label: string; context?: string; onSave: (text: string) => void; onCancel: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  return (
    <form className="comment-box" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSave(text.trim()); }}>
      <label>
        <span className="hint">{label}</span>
        {context && <code className="comment-context">{context}</code>}
        <textarea className="input" autoFocus rows={3} maxLength={MAX_COMMENT} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} aria-label={t("commentLabel")} placeholder={t("commentPlaceholder")} />
      </label>
      <div className="comment-actions">
        <button type="submit" className="btn-soft" disabled={!text.trim()}>{t("commentAdd")}</button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("cancel")}</button>
      </div>
    </form>
  );
}

/** Findings that belong to a file but to no hunk (or to a diff shown without hunks), with their own reply box. */
export function FindingsBlock({ file, findings, onDismiss, onComment }: { file: string; findings: Finding[]; onDismiss: (id: string) => void; onComment?: (c: NewComment) => void }) {
  const t = useT();
  const [reply, setReply] = useState<Finding | null>(null);
  if (!findings.length) return null;
  return (
    <div className="findings-block">
      {sortFindings(findings).map((f) => <FindingCard key={f.id} finding={f} onDismiss={onDismiss} onReply={onComment ? setReply : undefined} />)}
      {reply && onComment && <CommentBox label={`${t("findingReply")}: ${reply.title}`} onCancel={() => setReply(null)}
        onSave={(text) => { onComment({ file, line: reply.line, text, finding: reply.title }); setReply(null); }} />}
    </div>
  );
}

/** Findings of every reviewed file at the top of the panel: live status, summary, and a jump to the file/hunk. */
export function FindingsList({ findings, summary, statusText, running, error, onJump, onDismiss, onCancel }: {
  findings: (Finding & { reviewId: string })[]; summary: string; statusText: string; running: boolean; error: string;
  onJump: (f: Finding & { reviewId: string }) => void; onDismiss: (id: string) => void; onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="findings-list">
      <div className="findings-status" role="status" aria-live="polite">{statusText}</div>
      {running && <button className="btn-soft" onClick={onCancel}>{t("cancel")}</button>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {summary && <p className="findings-summary">{summary}</p>}
      {sortFindings(findings).map((f) => (
        <div key={f.id} className={`finding-row sev-${f.severity}`}>
          <button className="finding-jump" onClick={() => onJump(f)} aria-label={`${t("findingJump")}: ${f.file}${f.line ? `:${f.line}` : ""} - ${f.title}`}>
            <span className="chip">{t(SEVERITY_KEY[f.severity])}</span>
            <span className="finding-title">{f.title}</span>
            <span className="hint">{f.file}{f.line ? `:${f.line}` : ""}</span>
          </button>
          <button className="icon-btn" title={t("findingDismiss")} aria-label={`${t("findingDismiss")}: ${f.title}`} onClick={() => onDismiss(f.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

/** The comments collected next to the diff, to be sent to the agent as one follow-up. Sending waits while the agent works. */
export function FeedbackQueue({ comments, busy, canSend, onRemove, onSend }: { comments: FeedbackComment[]; busy: boolean; canSend: boolean; onRemove: (id: string) => void; onSend: () => void }) {
  const t = useT();
  if (!comments.length) return null;
  return (
    <div className="feedback-queue">
      <div className="feedback-head"><strong>{t("feedbackTitle", { count: comments.length })}</strong></div>
      <ul>
        {comments.map((c) => (
          <li key={c.id}>
            <span className="grow"><code>{c.file}{c.line ? `:${c.line}` : ""}</code> {c.text}</span>
            <button className="icon-btn" title={t("feedbackRemove")} aria-label={`${t("feedbackRemove")}: ${c.file}${c.line ? `:${c.line}` : ""}`} onClick={() => onRemove(c.id)}><X size={13} /></button>
          </li>
        ))}
      </ul>
      <button className="btn-soft" disabled={busy || !canSend} aria-describedby="feedback-wait" onClick={onSend}><Send size={13} /> {t("feedbackSend")}</button>
      <span id="feedback-wait" className="hint" role="status">{busy ? t("feedbackWaiting") : t("feedbackHint")}</span>
    </div>
  );
}
