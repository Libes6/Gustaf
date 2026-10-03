import { Check, ChevronDown, ChevronUp, GitBranch, RotateCcw, Sparkles, Undo2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { hasTerminalCommands, onTerminalCommand } from "../lib/terminalBridge";
import { changesSince, fileDiff, projectGit, restoreAll, restoreFile, type FileChange } from "../lib/checkpoints";
import type { StoredMsg } from "../lib/data";
import type { Part } from "../providers/types";
import { useDialogFocus } from "../lib/useDialogFocus";
import { gitRepo, review, type GitStatus, type Hunk, type Review, type ReviewChange } from "../lib/api";
import { EMPTY_REVIEW_SETUP, type ReviewSetupConfig } from "../lib/reviewSetup";
import { loadReviewSetup } from "../lib/reviewSetupStore";
import { acceptedFiles, offeredFiles } from "../lib/gitCommit";
import { GitCommitDialog } from "./GitCommitDialog";
import { buildFeedbackMessage, hunkFor, type FeedbackComment, type Finding } from "../lib/diffReview";
import { useDiffReview, type StoredFinding } from "../lib/useDiffReview";
import { useApp } from "../state";
import { HunkDiff } from "./HunkDiff";
import { FeedbackQueue, FindingsBlock, FindingsList, type NewComment } from "./ReviewFindings";
const ProjectPreview = lazy(() => import("./ProjectPreview").then(module => ({ default: module.ProjectPreview })));
const TerminalPanel = lazy(() => import("./TerminalPanel").then(module => ({ default: module.TerminalPanel })));
import { ReviewSetupForm, ReviewTestRun } from "./ReviewSetupPanel";

function DiffView({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text
        .split("\n")
        .filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))
        .map((l, i) => (
          <div key={i} className={l.startsWith("@@") ? "hunk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
            {l || " "}
          </div>
        ))}
    </pre>
  );
}

export function ChangesPanel({ name, root, busy, messages, tick, onChanged, onReplyToAgent }: { name: string; root: string; busy: boolean; messages: StoredMsg[]; tick: number; onChanged: () => void; onReplyToAgent?: (text: string) => void }) {
  const t = useT();
  const app = useApp();
  const aiReview = useDiffReview(root);
  const [comments, setComments] = useState<FeedbackComment[]>([]);
  const [focusHunk, setFocusHunk] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [terminalOpened, setTerminalOpened] = useState(false);
  const [previewOpened, setPreviewOpened] = useState(false);
  const [tab, setTab] = useState<"changes" | "terminal" | "preview">("changes");
  useEffect(() => {
    const show = () => { if (hasTerminalCommands(root)) { setOpen(true); setTab("terminal"); setTerminalOpened(true); } };
    show(); return onTerminalCommand(show);
  }, [root]);
  const [files, setFiles] = useState<FileChange[]>([]);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof projectGit>>>(null);
  const [diff, setDiff] = useState<{ path: string; text: string; reviewId?: string; hunks?: Hunk[] } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [setupCfg, setSetupCfg] = useState<ReviewSetupConfig>(EMPTY_REVIEW_SETUP);
  const [reviews, setReviews] = useState<[Review, ReviewChange[]][]>([]);
  const [acting, setActing] = useState(false);
  const [repo, setRepo] = useState<GitStatus | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  const base = messages.find((m) => m.meta?.checkpoint)?.meta?.checkpoint;

  const refresh = async () => {
    setInfo(await projectGit(root));
    setReviews(await review.list(root));
    setRepo(await gitRepo.status(root).catch(() => null));
    if (base) setFiles(await changesSince(root, base));
    else setFiles([]);
  };
  useEffect(() => {
    refresh().catch(e => setErr(String(e)));
  }, [root, base, tick]);
  useEffect(() => { loadReviewSetup(root).then(setSetupCfg).catch(() => setSetupCfg(EMPTY_REVIEW_SETUP)); }, [root]);

  const diffDialogRef = useRef<HTMLElement>(null);
  useDialogFocus(diffDialogRef, undefined, !!diff);
  useEffect(() => {
    if (!diff) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setDiff(null); } };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [diff]);

  const act = (fn: () => Promise<unknown>) => async () => {
    setErr("");
    setActing(true);
    try {
      await fn();
      setDiff(null);
      await refresh();
      onChanged();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setActing(false); }
  };

  // Accepting a file remembers it, so committing exactly those files can be offered afterwards.
  const accept = (id: string, path: string) => async () => { await review.decide(id, path, true); acceptedFiles.add(root, path); setNotice(""); };
  const offer = offeredFiles(repo, acceptedFiles.list(root));
  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  const pending = reviews.reduce((n, [, list]) => n + list.length, 0);
  const showDiff = async (path: string, reviewId?: string) => {
    setErr("");
    try {
      setPicked(new Set());
      const hunks = reviewId ? await review.hunks(reviewId, path).catch(() => []) : undefined;
      setDiff({ path, reviewId, text: reviewId ? await review.diff(reviewId, path) : await fileDiff(root, base!, path), hunks });
      return hunks;
    }
    catch (e) { setErr(String(e)); }
  };
  const canReview = !!app.selection && !busy && !acting && !aiReview.running;
  const reviewFiles = (only?: string) => aiReview.run(reviews.filter(([r]) => !only || r.id === only).flatMap(([r, list]) => list.filter(f => !f.binary).map(f => ({ reviewId: r.id, path: f.path }))));
  const jumpTo = async (f: StoredFinding) => {
    setFocusHunk(null);
    const hunks = await showDiff(f.file, f.reviewId);
    setFocusHunk((hunks && hunkFor(f, hunks)) ?? null);
  };
  const addComment = (c: NewComment) => setComments(old => [...old, { ...c, id: `c${Date.now()}-${old.length}` }]);
  const sendFeedback = () => {
    const text = buildFeedbackMessage(comments);
    if (!text || !onReplyToAgent || busy) return;
    onReplyToAgent(text);
    setComments([]);
    setNotice(t("feedbackSent"));
  };
  const st = aiReview.status;
  const statusText = st.phase === "running" ? t("aiReviewRunning", { count: st.files })
    : st.phase === "done" ? t("aiReviewDone", { count: st.count, files: st.files, model: st.model })
    : "";
  const statusError = st.phase === "error" ? (st.message === "unparsable" ? t("aiReviewUnparsable") : st.message) : "";
  const fileFindings = (path: string) => aiReview.findings.filter((f: Finding) => f.file === path);
  // Hunk-level decision: applies or reverts only the given hunks, then reloads the file's remaining diff (or closes when nothing is left).
  const decideHunks = async (ids: string[], accepting: boolean) => {
    if (!diff?.reviewId || !ids.length) return;
    const { reviewId, path } = diff;
    setErr("");
    setActing(true);
    try {
      await review.decideHunks(reviewId, path, ids, accepting);
      if (accepting) acceptedFiles.add(root, path);
      setNotice("");
      await refresh();
      onChanged();
      const left = (await review.list(root)).some(([r, list]) => r.id === reviewId && list.some(f => f.path === path));
      if (left) await showDiff(path, reviewId); else setDiff(null);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally { setActing(false); }
  };
  const { commands, outputs } = useMemo(() => {
    const commands: Extract<Part, { type: "tool_call" }>[] = [];
    const outputs = new Map<string, string>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === "tool_call" && part.name === "run_command") commands.push(part);
        if (part.type === "tool_result") outputs.set(part.id, part.output);
      }
    }
    return { commands, outputs };
  }, [messages]);

  return (
    <aside className={`panel${open ? " open" : ""}`} aria-label={t("changes")}>
      <div className="panel-head">
        <span className="grow">{name}</span>
        {pending > 0 && <button className="btn-soft" onClick={() => { setOpen(true); setTab("changes"); }}>{t("reviewPending")} · {pending}</button>}
        <button className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? t("collapse") : t("changes")} title={open ? t("collapse") : t("changes")}>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      <div className="panel-branch">
        <GitBranch size={13} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info?.branch ?? t("noGit")}</span>
        <span className="plus">+{t.num(info ? info.added : added)}</span>
        <span className="minus">−{t.num(info ? info.removed : removed)}</span>
      </div>
      {offer.length > 0 && <div className="commit-offer">
        <span className="grow">{t("gitOffer", { count: offer.length })}</span>
        <button className="btn-soft" disabled={busy || acting} onClick={() => setCommitOpen(true)}>{t("gitCommitAction")}</button>
        <button className="icon-btn" title={t("gitOfferDismiss")} aria-label={t("gitOfferDismiss")} onClick={() => { acceptedFiles.forget(root, offer.map(f => f.path)); refresh().catch(e => setErr(String(e))); }}><X size={13} /></button>
      </div>}
      {notice && <div className="commit-notice" role="status"><Check size={13} /><span className="grow">{notice}</span></div>}
      {commitOpen && <GitCommitDialog root={root} accepted={acceptedFiles.list(root)} onClose={() => setCommitOpen(false)} onCommitted={(r) => {
        acceptedFiles.forget(root, r.files);
        setNotice(t("gitCommitted", { sha: r.short, branch: r.branch ?? "HEAD" }));
        refresh().catch(e => setErr(String(e)));
        onChanged();
      }} />}
      {diff && createPortal(<div className="review-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !acting) setDiff(null); }}>
        <section ref={diffDialogRef} className="review-dialog" role="dialog" aria-modal="true" aria-label={diff.path}>
          <header><strong>{diff.path}</strong><button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={() => setDiff(null)}><X size={17} /></button></header>
          <div className="review-diff-body">
            {diff.hunks && diff.hunks.length > 0
              ? <HunkDiff file={diff.path} hunks={diff.hunks} picked={picked} disabled={busy || acting} onDecide={decideHunks}
                  findings={fileFindings(diff.path)} focusHunk={focusHunk} onDismissFinding={aiReview.dismiss} onComment={diff.reviewId ? addComment : undefined}
                  onToggle={id => setPicked(p => { const n = new Set(p); if (!n.delete(id)) n.add(id); return n; })} />
              : <><FindingsBlock file={diff.path} findings={fileFindings(diff.path)} onDismiss={aiReview.dismiss} onComment={diff.reviewId ? addComment : undefined} /><DiffView text={diff.text} /></>}
          </div>
          {err && <div className="error-box" role="alert">{err}</div>}
          {diff.reviewId && <div className="review-actions">
            <button className="btn btn-primary" disabled={busy || acting} onClick={act(accept(diff.reviewId!, diff.path))}>{t("reviewAccept")}</button>
            <button className="btn btn-ghost" disabled={busy || acting} onClick={act(() => review.decide(diff.reviewId!, diff.path, false))}>{t("reviewReject")}</button>
            <button className="btn-soft" disabled={!canReview} onClick={() => aiReview.run([{ reviewId: diff.reviewId!, path: diff.path }])}><Sparkles size={13} /> {t("aiReviewFile")}</button>
            {(diff.hunks?.length ?? 0) > 0 && <>
              <span style={{ flex: 1 }} />
              <button className="btn-soft" disabled={busy || acting || !picked.size} onClick={() => decideHunks([...picked], true)}>{t("hunkAcceptSelected", { count: picked.size })}</button>
              <button className="btn-soft" disabled={busy || acting || !picked.size} onClick={() => decideHunks([...picked], false)}>{t("hunkRejectSelected", { count: picked.size })}</button>
            </>}
          </div>}
        </section>
      </div>, document.body)}
      {open && (
        <>
          <div className="panel-tabs">
            <button className={tab === "changes" ? "active" : ""} aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>
              {t("changes")} {files.length ? `(${files.length})` : ""}
            </button>
            <button className={tab === "terminal" ? "active" : ""} aria-pressed={tab === "terminal"} onClick={() => { setTab("terminal"); setTerminalOpened(true); }}>
              {t("terminal")}
            </button>
            <button className={tab === "preview" ? "active" : ""} aria-pressed={tab === "preview"} onClick={() => { setTab("preview"); setPreviewOpened(true); }}>{t.locale === "ru" ? "Предпросмотр" : "Preview"}</button>
          </div>
          <div className="panel-body">
            {previewOpened && <div hidden={tab !== "preview"}><Suspense fallback={<div className="term">Preview…</div>}><ProjectPreview root={reviews[0]?.[0].workspace ?? root} onSendConsole={onReplyToAgent} /></Suspense></div>}
            {tab === "changes" && (
              <>
                <div className="review-intro"><strong>{t("reviewPending")}</strong><p>{t("reviewHint")}</p>
                  {pending > 0 && <button className="btn-soft" disabled={!canReview} onClick={() => reviewFiles()} title={t("aiReviewHint")}><Sparkles size={13} /> {t("aiReviewAll")}</button>}
                </div>
                <FindingsList findings={aiReview.findings} summary={aiReview.summary} statusText={statusText} running={aiReview.running} error={statusError}
                  onJump={jumpTo} onDismiss={aiReview.dismiss} onCancel={aiReview.cancel} />
                <FeedbackQueue comments={comments} busy={busy} canSend={!!onReplyToAgent} onRemove={id => setComments(old => old.filter(c => c.id !== id))} onSend={sendFeedback} />
                {busy && <div className="hint" style={{ padding: 12 }}>{t("reviewWorking")}</div>}
                {!pending && <div className="hint" style={{ padding: 12 }}>{t("reviewEmpty")}</div>}
                <ReviewSetupForm root={root} config={setupCfg} onSaved={setSetupCfg} />
                {reviews.map(([r, list]) => <div key={r.id} className="review-group">
                  {reviews.length > 1 && <button className="btn-soft review-ai" disabled={!canReview} onClick={() => reviewFiles(r.id)}><Sparkles size={13} /> {t("aiReviewGroup", { count: list.length })}</button>}
                  {setupCfg.testCommand && <ReviewTestRun reviewId={r.id} command={setupCfg.testCommand} tick={tick} busy={busy || acting} />}
                  {list.map(f => <div key={f.path} className="file-row review-row">
                  <button className="path review-path" onClick={() => showDiff(f.path, r.id)}>{f.path}<span className="hint">{t(f.binary ? "reviewBinary" : "reviewChanged")}</span></button>
                  <button className="icon-btn" disabled={busy || acting} title={t("reviewAccept")} aria-label={`${t("reviewAccept")}: ${f.path}`} onClick={act(accept(r.id, f.path))}><Check size={15} /></button>
                  <button className="icon-btn" disabled={busy || acting} title={t("reviewReject")} aria-label={`${t("reviewReject")}: ${f.path}`} onClick={act(() => review.decide(r.id, f.path, false))}><X size={15} /></button>
                </div>)}</div>)}
                {files.length > 0 && <div className="review-intro"><strong>{t("changes")}</strong></div>}
                {!files.length && <div className="hint" style={{ padding: 12 }}>{t("noChanges")}</div>}
                {files.map((f) => (
                  <div key={f.path} className="file-row">
                    <button className="path" onClick={() => showDiff(f.path)}>{f.path}</button>
                    <span className="plus">+{f.added}</span>
                    <span className="minus">−{f.removed}</span>
                    <button className="icon-btn" disabled={busy || acting} title={t("revertFile")} aria-label={`${t("revertFile")}: ${f.path}`} onClick={(e) => (e.stopPropagation(), act(() => restoreFile(root, base!, f.path))())}>
                      <Undo2 size={13} />
                    </button>
                  </div>
                ))}
              </>
            )}
            {terminalOpened && (
              <div hidden={tab !== "terminal"} style={{ minHeight: 260 }}>
                <Suspense fallback={<div className="term">{t("terminal")}…</div>}><TerminalPanel commandScope={root} root={reviews[0]?.[0].workspace ?? root} onSendSelection={onReplyToAgent} /></Suspense>
                <details className="term"><summary>{t("terminal")} · {t.locale === "ru" ? "История команд агента" : "Agent command history"}</summary>
                {!commands.length && t("noCommands")}
                {commands.map((c) => (
                  <div key={c.id} style={{ marginBottom: 10 }}>
                    <div className="cmd">$ {c.args.command}</div>
                    {outputs.get(c.id)}
                  </div>
                ))}
                </details>
              </div>
            )}
          </div>
          {err && <div className="error-box" style={{ margin: 8 }}>{err}</div>}
          <div className="panel-foot">
            {files.length > 0 && (
              <button className="btn-soft" disabled={busy || acting} onClick={act(() => restoreAll(root, base!))} title={t("revertAll")}>
                <RotateCcw size={13} />
              </button>
            )}
            {repo?.repo && <button className="btn-soft" disabled={busy || acting} onClick={() => setCommitOpen(true)}>{t("gitCommitAction")}</button>}
          </div>
        </>
      )}
    </aside>
  );
}
