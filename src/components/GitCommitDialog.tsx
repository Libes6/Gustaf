import { GitBranch, Loader2, Sparkles, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { gitRepo, type CommitResult, type GitFileKind, type GitStatus } from "../lib/api";
import { buildCommitPrompt, diffBudget, messageFromParts } from "../lib/commitMessage";
import { branchNameProblem, candidates, commitProblem, initialSelection, suggestBranchName, type Candidate } from "../lib/gitCommit";
import { getAdapter } from "../providers";
import { loadAgentSettings } from "../agent/agentSettingsStore";
import { cheapTarget } from "../lib/modelRouting";
import { useApp } from "../state";
import "../styles/gitCommit.css";

const KIND_LABEL = {
  modified: "gitKindModified",
  added: "gitKindAdded",
  deleted: "gitKindDeleted",
  untracked: "gitKindUntracked",
  conflicted: "gitKindConflicted",
} as const satisfies Record<GitFileKind, string>;
const KIND_LETTER: Record<GitFileKind, string> = { modified: "M", added: "A", deleted: "D", untracked: "U", conflicted: "!" };

/**
 * Commit dialog for the project's repository: pick files (the ones accepted in review are pre-selected),
 * write or generate a message with the model selected in the composer, optionally create a branch first.
 * Only the ticked files are committed; hooks run as usual and nothing is pushed.
 */
export function GitCommitDialog({ root, accepted, onClose, onCommitted }: { root: string; accepted: string[]; onClose: () => void; onCommitted: (result: CommitResult) => void }) {
  const t = useT();
  const app = useApp();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [generatedBy, setGeneratedBy] = useState("");
  const [generating, setGenerating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [branch, setBranch] = useState({ create: false, name: "" });
  const [error, setError] = useState("");
  const generation = useRef<AbortController | null>(null);

  const selection = app.selection;
  const provider = app.providers.find((p) => p.id === selection?.providerId);
  const model = app.models.find((m) => m.providerId === provider?.id && m.id === selection?.model);
  const modelName = model?.name ?? selection?.model ?? "";
  const busy = generating || committing;

  useEffect(() => {
    let cancelled = false;
    gitRepo.status(root).then(
      (st) => {
        if (cancelled) return;
        setStatus(st);
        setSelected(initialSelection(candidates(st, accepted)));
        // A commit on a detached HEAD is easy to lose, so start with a branch.
        if (st.detached) setBranch((b) => ({ ...b, create: true }));
      },
      (e) => { if (!cancelled) setLoadError(String(e?.message ?? e)); },
    );
    return () => { cancelled = true; };
  }, [root]);

  useEffect(() => () => generation.current?.abort(), []);

  useEffect(() => {
    const close = (e: KeyboardEvent) => { if (e.key === "Escape" && !committing) { e.stopPropagation(); onClose(); } };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [committing, onClose]);

  const list = useMemo(() => candidates(status, accepted), [status]);
  // An empty name field means "use the suggestion", which is shown as its placeholder.
  const suggestion = suggestBranchName(message);
  const branchName = branch.name.trim() || suggestion;
  const problem = commitProblem(status, selected, message, { create: branch.create, name: branchName });
  const nameProblem = branch.create && branch.name.trim() ? branchNameProblem(branch.name) : null;

  const setMany = (items: Candidate[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const f of items) if (f.kind !== "conflicted") (on ? next.add(f.path) : next.delete(f.path));
      return next;
    });
  const toggle = (path: string) => setSelected((prev) => { const next = new Set(prev); if (!next.delete(path)) next.add(path); return next; });

  async function generate() {
    if (busy || !provider || !selection || !status?.repo) return;
    const paths = [...selected];
    if (!paths.length) return setError(t("gitProblemNoFiles"));
    const ctl = new AbortController();
    generation.current = ctl;
    setGenerating(true);
    setError("");
    try {
      // The cheap model from the agent settings when configured and available, else the chat's model.
      const target = cheapTarget(await loadAgentSettings(), app, { provider, model: selection.model });
      const budget = diffBudget(target.info?.contextWindow);
      const context = await gitRepo.commitContext(root, paths, budget);
      const { system, user } = buildCommitPrompt(context, budget);
      const adapter = await getAdapter(target.provider);
      app.bumpUsage(target.provider.id);
      const out = await adapter.turn({
        system,
        messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
        tools: [], model: target.model, cwd: root, access: "readonly", signal: ctl.signal, onText: () => {},
      });
      app.recordTokens(target.provider.id, target.model, out.usage);
      if (ctl.signal.aborted) return;
      const text = messageFromParts(out.parts);
      if (!text) throw new Error(t("gitMessageFailed"));
      setMessage(text);
      setGeneratedBy(target.info?.name ?? target.model);
    } catch (e: any) {
      if (!ctl.signal.aborted) setError(String(e?.message ?? e));
    } finally {
      if (generation.current === ctl) generation.current = null;
      setGenerating(false);
    }
  }

  async function commit() {
    if (problem || busy) return;
    setCommitting(true);
    setError("");
    try {
      onCommitted(await gitRepo.commit(root, message, [...selected], branch.create ? branchName : null));
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setCommitting(false);
    }
  }

  const row = (f: Candidate) => (
    <label key={f.path} className="git-file" title={f.path}>
      <input type="checkbox" checked={selected.has(f.path)} disabled={busy || f.kind === "conflicted"} onChange={() => toggle(f.path)} />
      <span className={`git-kind ${f.kind}`} title={t(KIND_LABEL[f.kind])}>{KIND_LETTER[f.kind]}</span>
      <span className="git-path">{f.path}</span>
      {f.staged && <span className="git-tag">{t("gitStaged")}</span>}
    </label>
  );
  const group = (title: string, items: Candidate[]) =>
    items.length > 0 && (
      <div>
        <div className="git-group-head">
          <strong>{title}</strong>
          <span className="grow">{items.length}</span>
          <button className="btn-ghost small" disabled={busy} onClick={() => setMany(items, true)}>{t("gitSelectAll")}</button>
          <button className="btn-ghost small" disabled={busy} onClick={() => setMany(items, false)}>{t("gitSelectNone")}</button>
        </div>
        <div className="git-files">{items.map(row)}</div>
      </div>
    );

  const branchText = !status ? "" : status.detached ? t("gitDetached", { sha: status.head ?? "?" }) : status.head ? status.branch ?? "" : t("gitNoCommits", { branch: status.branch ?? "" });
  const problemText = problem === "noFiles" ? t("gitProblemNoFiles") : problem === "noMessage" ? t("gitProblemNoMessage") : problem === "badBranch" ? t("gitBranchInvalid") : "";

  return createPortal(
    <div className="review-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !committing) onClose(); }}>
      <section className="review-dialog git-dialog" role="dialog" aria-modal="true" aria-label={t("gitCommitTitle")}>
        <header>
          <strong>{t("gitCommitTitle")}</strong>
          <button className="icon-btn" title={t("cancel")} aria-label={t("cancel")} onClick={onClose} disabled={committing}><X size={17} /></button>
        </header>
        <div className="git-body">
          {!status && !loadError && <div className="git-state"><Loader2 size={14} className="spin" /> {t("gitLoading")}</div>}
          {loadError && <div className="error-box git-error" role="alert">{loadError}</div>}
          {status && !status.repo && <div className="git-state">{t("gitNotRepo")}</div>}
          {status?.repo && (
            <>
              <div className="git-state">
                <GitBranch size={14} aria-label={t("gitBranchLabel")} />
                <strong>{branchText}</strong>
                <span>· {status.total > 0 ? t("gitDirty", { count: status.total }) : t("gitClean")}</span>
              </div>
              {status.prefix && <div className="git-note muted">{t("gitRepoRoot", { path: status.toplevel })}</div>}
              {status.inProgress && <div className="error-box git-error" role="alert">{t("gitInProgress", { state: status.inProgress })}</div>}
              {status.detached && <div className="git-note">{t("gitDetachedHint")}</div>}
              {group(t("gitFilesAccepted"), list.filter((f) => f.accepted))}
              {group(t("gitFilesOther"), list.filter((f) => !f.accepted))}
              {status.total > status.files.length && <div className="git-note muted">{t("gitTruncated", { shown: status.files.length, total: status.total })}</div>}
              {list.length > 0 && <div className="git-note muted">{t("gitFilesNote")}</div>}

              <div>
                <div className="git-message-head">
                  <label htmlFor="git-commit-message">{t("commitMessage")}</label>
                  <button className="btn-soft" disabled={busy || !provider || selected.size === 0} onClick={generate} title={provider ? modelName : t("gitNoModel")}>
                    {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} {generating ? t("gitGenerating") : message.trim() ? t("gitRegenerate") : t("gitGenerate")}
                  </button>
                </div>
                <textarea
                  id="git-commit-message" className="input git-message" rows={6} value={message} disabled={committing}
                  placeholder={t("gitMessagePlaceholder")} spellCheck
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); commit(); } }}
                />
                <div className="git-note muted">{!provider ? t("gitNoModel") : generatedBy ? t("gitModelNote", { model: generatedBy }) : ""}</div>
              </div>

              <div>
                <label className="git-check">
                  <input type="checkbox" checked={branch.create} disabled={busy} onChange={(e) => setBranch((b) => ({ ...b, create: e.target.checked }))} />
                  {t("gitNewBranch")}
                </label>
                {branch.create && (
                  <>
                    <input
                      className="input git-branch-name" value={branch.name} disabled={busy} spellCheck={false} autoCapitalize="off" autoCorrect="off"
                      placeholder={suggestion} aria-label={t("gitBranchName")} aria-invalid={nameProblem ? true : undefined}
                      onChange={(e) => setBranch({ create: true, name: e.target.value })}
                    />
                    {nameProblem ? <div className="git-note bad">{t("gitBranchInvalid")}</div> : <div className="git-note muted">{t("gitBranchAuto")}</div>}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {error && <div className="error-box git-error git-error-foot" role="alert">{error}</div>}
        <div className="review-actions git-actions">
          <span className="git-note muted grow">{problemText || t("gitSafetyNote")}</span>
          <button className="btn btn-ghost" onClick={onClose} disabled={committing}>{t("cancel")}</button>
          <button className="btn btn-primary" disabled={!!problem || busy} onClick={commit}>
            {committing && <Loader2 size={13} className="spin" />} {committing ? t("gitCommitting") : t("gitCommitButton", { count: selected.size })}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
