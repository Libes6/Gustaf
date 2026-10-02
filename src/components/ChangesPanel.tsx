import { Check, ChevronDown, ChevronUp, GitBranch, RotateCcw, Undo2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useState } from "react";
import { useT } from "../i18n";
import { changesSince, commitAll, fileDiff, projectGit, restoreAll, restoreFile, type FileChange } from "../lib/checkpoints";
import type { StoredMsg } from "../lib/data";
import type { Part } from "../providers/types";
import { review, type Review, type ReviewChange } from "../lib/api";

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

export function ChangesPanel({ name, root, busy, messages, tick, onChanged }: { name: string; root: string; busy: boolean; messages: StoredMsg[]; tick: number; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"changes" | "terminal">("changes");
  const [files, setFiles] = useState<FileChange[]>([]);
  const [info, setInfo] = useState<Awaited<ReturnType<typeof projectGit>>>(null);
  const [diff, setDiff] = useState<{ path: string; text: string; reviewId?: string } | null>(null);
  const [reviews, setReviews] = useState<[Review, ReviewChange[]][]>([]);
  const [acting, setActing] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const base = messages.find((m) => m.meta?.checkpoint)?.meta?.checkpoint;

  const refresh = async () => {
    setInfo(await projectGit(root));
    setReviews(await review.list(root));
    if (base) setFiles(await changesSince(root, base));
    else setFiles([]);
  };
  useEffect(() => {
    refresh().catch(e => setErr(String(e)));
  }, [root, base, tick]);

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

  const added = files.reduce((s, f) => s + f.added, 0);
  const removed = files.reduce((s, f) => s + f.removed, 0);
  const pending = reviews.reduce((n, [, list]) => n + list.length, 0);
  const showDiff = async (path: string, reviewId?: string) => {
    setErr("");
    try { setDiff({ path, reviewId, text: reviewId ? await review.diff(reviewId, path) : await fileDiff(root, base!, path) }); }
    catch (e) { setErr(String(e)); }
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
    <div className={`panel${open ? " open" : ""}`}>
      <div className="panel-head">
        <span className="grow">{name}</span>
        {pending > 0 && <button className="btn-soft" onClick={() => { setOpen(true); setTab("changes"); }}>{t("reviewPending")} · {pending}</button>}
        <button className="icon-btn" onClick={() => setOpen(!open)} title={open ? t("collapse") : t("changes")}>
          {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      <div className="panel-branch">
        <GitBranch size={13} />
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info?.branch ?? t("noGit")}</span>
        <span className="plus">+{t.num(info ? info.added : added)}</span>
        <span className="minus">−{t.num(info ? info.removed : removed)}</span>
      </div>
      {diff && createPortal(<div className="review-overlay" onMouseDown={e => { if (e.target === e.currentTarget && !acting) setDiff(null); }}>
        <section className="review-dialog" role="dialog" aria-modal="true" aria-label={diff.path}>
          <header><strong>{diff.path}</strong><button className="icon-btn" title={t("cancel")} onClick={() => setDiff(null)}><X size={17} /></button></header>
          <div className="review-diff-body"><DiffView text={diff.text} /></div>
          {err && <div className="error-box" role="alert">{err}</div>}
          {diff.reviewId && <div className="review-actions">
            <button className="btn btn-primary" disabled={busy || acting} onClick={act(() => review.decide(diff.reviewId!, diff.path, true))}>{t("reviewAccept")}</button>
            <button className="btn btn-ghost" disabled={busy || acting} onClick={act(() => review.decide(diff.reviewId!, diff.path, false))}>{t("reviewReject")}</button>
          </div>}
        </section>
      </div>, document.body)}
      {open && (
        <>
          <div className="panel-tabs">
            <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
              {t("changes")} {files.length ? `(${files.length})` : ""}
            </button>
            <button className={tab === "terminal" ? "active" : ""} onClick={() => setTab("terminal")}>
              {t("terminal")}
            </button>
          </div>
          <div className="panel-body">
            {tab === "changes" && (
              <>
                <div className="review-intro"><strong>{t("reviewPending")}</strong><p>{t("reviewHint")}</p></div>
                {busy && <div className="hint" style={{ padding: 12 }}>{t("reviewWorking")}</div>}
                {!pending && <div className="hint" style={{ padding: 12 }}>{t("reviewEmpty")}</div>}
                {reviews.map(([r, list]) => <div key={r.id} className="review-group">{list.map(f => <div key={f.path} className="file-row review-row">
                  <button className="path review-path" onClick={() => showDiff(f.path, r.id)}>{f.path}<span className="hint">{t(f.binary ? "reviewBinary" : "reviewChanged")}</span></button>
                  <button className="icon-btn" disabled={busy || acting} title={t("reviewAccept")} aria-label={`${t("reviewAccept")}: ${f.path}`} onClick={act(() => review.decide(r.id, f.path, true))}><Check size={15} /></button>
                  <button className="icon-btn" disabled={busy || acting} title={t("reviewReject")} aria-label={`${t("reviewReject")}: ${f.path}`} onClick={act(() => review.decide(r.id, f.path, false))}><X size={15} /></button>
                </div>)}</div>)}
                {files.length > 0 && <div className="review-intro"><strong>{t("changes")}</strong></div>}
                {!files.length && <div className="hint" style={{ padding: 12 }}>{t("noChanges")}</div>}
                {files.map((f) => (
                  <div key={f.path} className="file-row" onClick={() => showDiff(f.path)}>
                    <span className="path">{f.path}</span>
                    <span className="plus">+{f.added}</span>
                    <span className="minus">−{f.removed}</span>
                    <button className="icon-btn" disabled={busy || acting} title={t("revertFile")} onClick={(e) => (e.stopPropagation(), act(() => restoreFile(root, base!, f.path))())}>
                      <Undo2 size={13} />
                    </button>
                  </div>
                ))}
              </>
            )}
            {tab === "terminal" && (
              <div className="term">
                {!commands.length && t("noCommands")}
                {commands.map((c) => (
                  <div key={c.id} style={{ marginBottom: 10 }}>
                    <div className="cmd">$ {c.args.command}</div>
                    {outputs.get(c.id)}
                  </div>
                ))}
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
            {info && (
              <>
                <input className="input" style={{ height: 28 }} placeholder={t("commitMessage")} value={msg} onChange={(e) => setMsg(e.target.value)} />
                <button className="btn-soft" disabled={busy || acting || !msg.trim()} onClick={act(async () => (await commitAll(root, msg.trim()), setMsg("")))}>
                  {t("commit")}
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
