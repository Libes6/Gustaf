import { Check, MessageSquarePlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { Hunk } from "../lib/api";
import { lineNumbers, placeFindings, sortFindings, type Finding } from "../lib/diffReview";
import { CommentBox, FindingCard, FindingsBlock, type NewComment } from "./ReviewFindings";
import "../styles/reviewSetup.css";

type Box = { hunkId: string; line?: number; finding?: string };

/**
 * Diff of one reviewed file split into hunks, each of which can be ticked, accepted or rejected on its own.
 * With `findings` (AI review) they are shown under the hunk they belong to; with `onComment` a line or a whole hunk can be
 * commented on (collected by the caller and sent to the agent). `focusHunk` scrolls a hunk into view.
 */
export function HunkDiff({ file, hunks, picked, disabled, findings = [], focusHunk, onToggle, onDecide, onDismissFinding, onComment }: {
  file?: string;
  hunks: Hunk[];
  picked: Set<string>;
  disabled: boolean;
  findings?: Finding[];
  focusHunk?: string | null;
  onToggle: (id: string) => void;
  onDecide: (ids: string[], accept: boolean) => void;
  onDismissFinding?: (id: string) => void;
  onComment?: (c: NewComment) => void;
}) {
  const t = useT();
  const [box, setBox] = useState<Box | null>(null);
  const { byHunk, loose } = placeFindings(findings, hunks);
  const dismiss = onDismissFinding ?? (() => {});
  useEffect(() => {
    if (!focusHunk) return;
    const el = document.getElementById(`hunk-${focusHunk}`);
    if (el) { el.scrollIntoView?.({ block: "center" }); el.focus({ preventScroll: true }); }
  }, [focusHunk]);
  const commentOn = (h: Hunk, line: number | undefined, lineText: string | undefined, finding: string | undefined, text: string) => {
    onComment?.({ file: file ?? "", line, hunk: h.header, context: lineText, text, finding });
    setBox(null);
  };
  return (
    <div className="hunks">
      {file && <FindingsBlock file={file} findings={loose} onDismiss={dismiss} onComment={onComment} />}
      {hunks.map((h, i) => {
        const nums = lineNumbers(h);
        const mine = byHunk.get(h.id) ?? [];
        const open = box?.hunkId === h.id ? box : null;
        const lineText = open?.line ? (() => { const k = nums.findIndex((n) => n.new === open.line); return k >= 0 ? `${h.lines[k].kind}${h.lines[k].text}` : undefined; })() : undefined;
        return (
          <section key={h.id} id={`hunk-${h.id}`} tabIndex={-1} className="hunk-block" aria-label={h.header}>
            <div className="hunk-head">
              <input type="checkbox" checked={picked.has(h.id)} disabled={disabled} onChange={() => onToggle(h.id)} aria-label={t("hunkSelect", { number: i + 1 })} />
              <span className="grow">{h.header}</span>
              {onComment && <button className="icon-btn" title={t("commentHunk")} aria-label={`${t("commentHunk")}: ${h.header}`} onClick={() => setBox({ hunkId: h.id })}><MessageSquarePlus size={15} /></button>}
              <button className="icon-btn" disabled={disabled} title={t("hunkAccept")} aria-label={`${t("hunkAccept")}: ${h.header}`} onClick={() => onDecide([h.id], true)}><Check size={15} /></button>
              <button className="icon-btn" disabled={disabled} title={t("hunkReject")} aria-label={`${t("hunkReject")}: ${h.header}`} onClick={() => onDecide([h.id], false)}><X size={15} /></button>
            </div>
            <pre className="diff">
              {h.lines.map((l, n) => (
                <div key={n} className={`${l.kind === "+" ? "add" : l.kind === "-" ? "del" : ""}${onComment && nums[n].new ? " commentable" : ""}`}>
                  {onComment && nums[n].new
                    ? <button type="button" tabIndex={-1} className="line-comment" aria-label={t("commentLine", { line: nums[n].new! })} onClick={() => setBox({ hunkId: h.id, line: nums[n].new })}>+</button>
                    : null}
                  {l.kind}{l.text || " "}
                </div>
              ))}
            </pre>
            {mine.length > 0 && <div className="findings-block">{sortFindings(mine).map((f) => (
              <FindingCard key={f.id} finding={f} onDismiss={dismiss} onReply={onComment ? (x) => setBox({ hunkId: h.id, line: x.line, finding: x.title }) : undefined} />
            ))}</div>}
            {open && onComment && !open.finding && (
              <label className="comment-line">
                <span className="hint">{t("commentAtLine")}</span>
                <select className="input" value={open.line ?? ""} onChange={(e) => setBox({ hunkId: h.id, line: e.target.value ? Number(e.target.value) : undefined })}>
                  <option value="">{t("commentWholeHunk")}</option>
                  {nums.filter((n) => n.new).map((n) => <option key={n.new} value={n.new}>{n.new}</option>)}
                </select>
              </label>
            )}
            {open && onComment && (
              <CommentBox label={open.finding ? `${t("findingReply")}: ${open.finding}` : open.line ? t("commentLine", { line: open.line }) : t("commentHunk")} context={lineText}
                onCancel={() => setBox(null)} onSave={(text) => commentOn(h, open.line, lineText, open.finding, text)} />
            )}
          </section>
        );
      })}
    </div>
  );
}
