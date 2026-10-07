import { Check, ChevronDown, FolderGit2, GitBranch, Monitor, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { gitRepo, review, type BranchEntry, type BranchList, type GitStatus } from "../../lib/api";
import { branchErrorCode, canCreateBranch, filterBranches, lockReason } from "../../lib/branchSwitch";
import "../../styles/branchSwitcher.css";

const POLL_MS = 4000;

/**
 * The bar under the composer: where the chat works (local checkout or its worktree) and its git branch, with a picker
 * to switch or create a branch. Switching never discards work: a dirty tree asks first (stash and switch, or cancel),
 * and a run, pending review changes or an unfinished merge disable it. The branch is re-read while visible and on
 * focus, so a checkout made in a terminal shows up.
 */
export function BranchSwitcher({ root, running, worktree, visible = true, onChanged }: {
  root: string | null;
  running: boolean;
  /** The chat runs in its own worktree: its branch is shown, not switched. */
  worktree: boolean;
  visible?: boolean;
  onChanged?: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<BranchList | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState<{ name: string; remote: boolean; count: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ name: string; remote: boolean } | null>(null);
  const busyRef = useRef(false);
  busyRef.current = busy;

  const refresh = useCallback(async () => {
    if (!root) return;
    const [st, pending] = await Promise.all([
      gitRepo.status(root).catch(() => null),
      review.list(root).then((l) => Array.isArray(l) && l.some(([, changes]) => changes.length > 0), () => false),
    ]);
    setStatus(st);
    setReviewPending(pending);
  }, [root]);

  useEffect(() => { setStatus(null); setOpen(false); setNotice(""); setError(""); }, [root]);
  useEffect(() => { void refresh(); }, [refresh, running]);
  useEffect(() => {
    if (!root || !visible) return;
    const tick = () => { if (!busyRef.current && document.visibilityState !== "hidden") void refresh(); };
    const id = setInterval(tick, POLL_MS);
    addEventListener("focus", tick);
    return () => { clearInterval(id); removeEventListener("focus", tick); };
  }, [root, visible, refresh]);

  const close = useCallback(() => { setOpen(false); setDirty(null); setError(""); setQuery(""); trigger.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, close]);
  useEffect(() => { if (open) search.current?.focus(); }, [open]);

  if (!root || !status?.repo) return null;

  const locked = lockReason({ worktree, running, reviewPending, inProgress: status.inProgress });
  const lockText = locked === "worktree" ? t("gitLockedWorktree") : locked === "running" ? t("gitLockedRunning") : locked === "review" ? t("gitLockedReview") : locked === "op" ? t("gitLockedOp", { op: status.inProgress ?? "" }) : "";
  const label = status.branch ?? t("gitBarDetached", { head: status.head ?? "?" });
  const changes = status.total;

  const openPicker = () => {
    if (locked) return;
    setOpen(true);
    setNotice("");
    setList(null);
    gitRepo.branches(root).then(setList, (e) => setError(String(e?.message ?? e)));
  };

  const fail = (e: unknown) => {
    const text = String((e as { message?: string })?.message ?? e);
    const { code, rest } = branchErrorCode(text);
    if (code === "dirty") return setDirty({ ...(pending.current ?? { name: "", remote: false }), count: Number(rest) || 0 });
    setError(code === "checked_out_elsewhere" ? t("gitErrElsewhere", { path: rest }) : code === "in_progress" ? t("gitErrOp") : t("gitErrGeneric", { error: rest || text }));
  };

  const switchTo = async (name: string, remote: boolean, stash: boolean) => {
    pending.current = { name, remote };
    setBusy(true);
    setError("");
    try {
      const r = await gitRepo.switchBranch(root, name, remote, stash);
      const to = r.branch ?? name;
      setNotice(r.stashed ? (r.restored ? t("gitSwitchedStashed", { branch: to }) : t("gitSwitchedKept", { branch: to, label: `gustaf: before switching to ${to}` })) : t("gitSwitched", { branch: to }));
      setOpen(false); setDirty(null); setQuery("");
      await refresh();
      onChanged?.();
      trigger.current?.focus();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const create = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      const made = await gitRepo.createBranch(root, name);
      setNotice(t("gitCreated", { branch: made }));
      setOpen(false); setQuery("");
      await refresh();
      onChanged?.();
      trigger.current?.focus();
    } catch (e) { setError(t("gitErrGeneric", { error: String((e as { message?: string })?.message ?? e) })); } finally { setBusy(false); }
  };

  const shown = list ? filterBranches(list.branches, query) : [];
  const local = shown.filter((b) => !b.remote);
  const remote = shown.filter((b) => b.remote);
  const makeName = canCreateBranch(query, list?.branches ?? []);
  const row = (b: BranchEntry) => {
    const blocked = !!b.checkedOutAt;
    return (
      <li key={`${b.remote ? "r" : "l"}:${b.name}`}>
        <button className={`branch-row${b.current ? " current" : ""}`} disabled={busy || blocked} title={blocked ? t("gitCheckedOutAt", { path: b.checkedOutAt ?? "" }) : b.name}
          aria-current={b.current ? "true" : undefined} onClick={() => (b.current ? close() : void switchTo(b.name, b.remote, false))}>
          <GitBranch size={13} aria-hidden="true" />
          <span className="name">{b.name}</span>
          {b.remote && <span className="tag">{t("gitRemoteTag")}</span>}
          {b.current && <Check size={13} aria-label={t("gitCurrentTag")} />}
        </button>
      </li>
    );
  };

  return (
    <div className="branch-switch" role="group" aria-label={t("gitBarLabel")} ref={wrap}>
      <span className="branch-loc">{worktree ? <FolderGit2 size={13} aria-hidden="true" /> : <Monitor size={13} aria-hidden="true" />}{worktree ? t("gitLocWorktree") : t("gitLocLocal")}</span>
      <button ref={trigger} className="chip branch-trigger" aria-haspopup="dialog" aria-expanded={open} aria-disabled={!!locked}
        title={lockText || t("gitSwitchTitle")} onClick={() => (open ? close() : openPicker())} data-locked={locked ?? undefined}>
        <GitBranch size={13} aria-hidden="true" />
        <span className="name">{label}</span>
        {!worktree && <ChevronDown size={12} aria-hidden="true" />}
      </button>
      {changes > 0 && <span className="branch-changes" title={t("gitDirtyTitle", { count: changes })}>{t("gitChanges", { count: changes })}</span>}
      {lockText && locked !== "worktree" && <span className="branch-lock hint">{lockText}</span>}
      {notice && <span className="hint" role="status">{notice}</span>}
      {open && (
        <div className="branch-pop" role="dialog" aria-label={t("gitSwitchTitle")}>
          {dirty ? (
            <div className="branch-dirty" role="alertdialog" aria-label={t("gitDirtyTitle", { count: dirty.count })}>
              <strong>{t("gitDirtyTitle", { count: dirty.count })}</strong>
              <p>{t("gitDirtyBody")}</p>
              <div className="branch-actions">
                <button className="btn-ghost" disabled={busy} onClick={() => setDirty(null)}>{t("cancel")}</button>
                <button className="btn-soft" disabled={busy} onClick={() => void switchTo(dirty.name, dirty.remote, true)}>{t("gitStashSwitch")}</button>
              </div>
            </div>
          ) : (
            <>
              <input ref={search} className="branch-search" value={query} placeholder={t("gitSearchBranches")} aria-label={t("gitSearchBranches")} spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && shown.length === 1 && !shown[0].checkedOutAt && !shown[0].current) void switchTo(shown[0].name, shown[0].remote, false); }} />
              <div className="branch-scroll">
                {local.length > 0 && <ul aria-label={t("gitLocalBranches")}>{local.map(row)}</ul>}
                {remote.length > 0 && <><div className="branch-group">{t("gitRemoteBranches")}</div><ul aria-label={t("gitRemoteBranches")}>{remote.map(row)}</ul></>}
                {list && shown.length === 0 && <div className="hint branch-empty">{t("gitNoBranches")}</div>}
                {list?.truncated && <div className="hint branch-empty">{t("gitBarTruncated")}</div>}
              </div>
              {makeName && (
                <div className="branch-create">
                  <button className="branch-row" disabled={busy} onClick={() => void create(makeName)}>
                    <Plus size={13} aria-hidden="true" />
                    <span className="name">{t("gitCreateFrom", { name: makeName, from: status.branch ?? status.head ?? "HEAD" })}</span>
                  </button>
                  {changes > 0 && <div className="hint">{t("gitCreateHint")}</div>}
                </div>
              )}
            </>
          )}
          {error && <div className="error-box" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
