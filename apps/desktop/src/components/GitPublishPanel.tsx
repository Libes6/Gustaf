import { Check, ExternalLink, Loader2, Sparkles, Upload, Eye } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { gitRepo, type GhStatus, type PublishInfo } from "../lib/api";
import { diffBudget } from "../lib/commitMessage";
import {
  baseOptions,
  buildPrPrompt,
  defaultBase,
  isPushed,
  manualPrCommand,
  manualPushCommand,
  planPush,
  prBodyFromParts,
  prProblem,
  prTitleFromMessage,
  pushArgs,
  safePrUrl,
} from "../lib/gitPublish";
import { branchNameProblem, suggestBranchName } from "../lib/gitCommit";
import { getAdapter } from "../providers";
import { loadAgentSettings } from "../agent/agentSettingsStore";
import { cheapTarget } from "../lib/modelRouting";
import { useApp } from "../state";
import { startPrWatch } from "../lib/prWatch";

const errText = (e: any) => String(e?.message ?? e);

/**
 * Shown in the commit dialog once the commit succeeded. Everything here is an explicit click: Push, Create branch
 * and Create pull request. Pushing never forces; pushing a protected branch (main, master, develop) asks first and
 * offers a new branch. Pull requests need `gh` (installed and signed in); without it the manual command is shown.
 */
export function GitPublishPanel({
  root,
  message,
  chatId,
}: {
  root: string;
  message: string;
  /** Offers watching the created PR in this chat (T9). */ chatId?: number | null;
}) {
  const t = useT();
  const app = useApp();
  const [info, setInfo] = useState<PublishInfo | null>(null);
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [remote, setRemote] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushNote, setPushNote] = useState("");
  const [pushError, setPushError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [prOpen, setPrOpen] = useState(false);
  const [title, setTitle] = useState(() => prTitleFromMessage(message));
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [prError, setPrError] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [watching, setWatching] = useState(false);
  const generation = useRef<AbortController | null>(null);

  const selection = app.selection;
  const provider = app.providers.find((p) => p.id === selection?.providerId);
  const busy = pushing || generating || creating;

  useEffect(() => {
    let cancelled = false;
    gitRepo.publishInfo(root).then(
      (i) => {
        if (!cancelled) setInfo(i);
      },
      (e) => {
        if (!cancelled) setLoadError(errText(e));
      },
    );
    gitRepo.ghStatus(root).then(
      (g) => {
        if (!cancelled) setGh(g);
      },
      (e) => {
        if (!cancelled) setGh({ installed: false, authenticated: false, detail: errText(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [root]);
  useEffect(() => () => generation.current?.abort(), []);

  const plan = useMemo(() => planPush(info, remote), [info, remote]);
  const bases = useMemo(
    () => baseOptions(info?.remoteBranches ?? [], plan.remote, info?.branch ?? null),
    [info, plan.remote],
  );
  useEffect(() => {
    if (!bases.includes(base)) setBase(defaultBase(bases, info?.defaultBase));
  }, [bases, info?.defaultBase]);

  const pushed = isPushed(info);
  const problem = prProblem({ gh, remote: plan.remote, branch: info?.branch ?? null, base, title, pushed });
  const problemText: Record<string, string> = {
    ghMissing: t("gitPrGhMissing"),
    ghSignedOut: t("gitPrGhSignedOut"),
    noRemote: t("gitPushNoRemote"),
    notPushed: t("gitPrNotPushed"),
    noBase: t("gitPrNoBase"),
    sameBase: t("gitPrSameBase"),
    noTitle: t("gitPrNoTitle"),
    titleTooLong: t("gitPrTitleLong"),
  };

  async function doPush(confirmed: boolean) {
    if (busy || plan.problem) return;
    if (plan.needsConfirm && !confirmed) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setPushing(true);
    setPushError("");
    setPushNote("");
    try {
      const res = await gitRepo.push(pushArgs(plan, root, confirmed));
      setInfo(res.info);
      setPushNote(t("gitPushed", { branch: res.branch, remote: res.remote }));
    } catch (e) {
      setPushError(errText(e));
    } finally {
      setPushing(false);
    }
  }

  const branchProblem = newBranch.trim() ? branchNameProblem(newBranch) : null;
  async function branchFirst() {
    if (busy) return;
    const name = newBranch.trim() || suggestBranchName(message);
    if (branchNameProblem(name)) return setPushError(t("gitBranchInvalid"));
    setPushError("");
    try {
      await gitRepo.createBranch(root, name);
      setInfo(await gitRepo.publishInfo(root));
      setConfirming(false);
      setPushNote(t("gitBranchSwitched", { branch: name }));
    } catch (e) {
      setPushError(errText(e));
    }
  }

  async function generate() {
    if (busy || !provider || !selection || !plan.remote || !base) return;
    const ctl = new AbortController();
    generation.current = ctl;
    setGenerating(true);
    setPrError("");
    try {
      const target = cheapTarget(await loadAgentSettings(), app, { provider, model: selection.model });
      const budget = diffBudget(target.info?.contextWindow);
      const context = await gitRepo.prContext(root, `${plan.remote}/${base}`, budget);
      const { system, user } = buildPrPrompt(context, title, base, budget);
      const adapter = await getAdapter(target.provider);
      app.bumpUsage(target.provider.id);
      const out = await adapter.turn({
        system,
        messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
        tools: [],
        model: target.model,
        cwd: root,
        access: "readonly",
        signal: ctl.signal,
        onText: () => {},
      });
      app.recordTokens(target.provider.id, target.model, out.usage);
      if (ctl.signal.aborted) return;
      const text = prBodyFromParts(out.parts);
      if (!text) throw new Error(t("gitMessageFailed"));
      setBody(text);
    } catch (e) {
      if (!ctl.signal.aborted) setPrError(errText(e));
    } finally {
      if (generation.current === ctl) generation.current = null;
      setGenerating(false);
    }
  }

  async function createPr() {
    if (busy || problem) return;
    setCreating(true);
    setPrError("");
    try {
      const res = await gitRepo.createPr(root, title.trim(), body, base, draft);
      setPrUrl(res.url);
    } catch (e) {
      setPrError(errText(e));
    } finally {
      setCreating(false);
    }
  }

  async function openPr() {
    const url = safePrUrl(prUrl);
    if (!url) return setPrError(t("gitPrBadUrl"));
    try {
      await (await import("@tauri-apps/plugin-opener")).openUrl(url);
    } catch (e) {
      setPrError(errText(e));
    }
  }

  const branch = info?.branch ?? "";
  const sync = !info?.upstream
    ? t("gitNoUpstream")
    : t("gitAheadBehind", { upstream: info.upstream, ahead: info.ahead ?? 0, behind: info.behind ?? 0 });
  const pushProblemText =
    plan.problem === "detached"
      ? t("gitPushDetached")
      : plan.problem === "noRemote" || plan.problem === "noRepo"
        ? t("gitPushNoRemote")
        : plan.problem === "noCommits"
          ? t("gitPushNoCommits")
          : "";

  return (
    <div className="git-publish">
      <div className="git-done">
        <Check size={15} /> <strong>{t("gitCommitDone")}</strong>
      </div>
      {!info && !loadError && (
        <div className="git-state">
          <Loader2 size={14} className="spin" /> {t("gitLoading")}
        </div>
      )}
      {loadError && (
        <div className="error-box git-error" role="alert">
          {loadError}
        </div>
      )}
      {info && (
        <section className="git-publish-block" aria-label={t("gitPushTitle")}>
          <div className="git-message-head">
            <strong className="grow">{t("gitPushTitle")}</strong>
            {info.remotes.length > 1 && (
              <select
                className="input git-select"
                value={plan.remote ?? ""}
                disabled={busy}
                aria-label={t("gitRemote")}
                onChange={(e) => setRemote(e.target.value)}
              >
                {info.remotes.map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="btn-soft"
              disabled={busy || !!plan.problem || plan.upToDate}
              onClick={() => doPush(false)}
            >
              {pushing ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}{" "}
              {pushing ? t("gitPushing") : t("gitPushButton", { branch })}
            </button>
          </div>
          <div className="git-note muted">{pushProblemText || `${branch} · ${sync}`}</div>
          {plan.remote && <div className="git-note muted">{info.remotes.find((r) => r.name === plan.remote)?.url}</div>}
          {confirming && (
            <div className="git-confirm" role="alertdialog" aria-label={t("gitProtectedTitle")}>
              <div>{t("gitProtectedWarn", { branch })}</div>
              <input
                className="input git-branch-name"
                value={newBranch}
                spellCheck={false}
                placeholder={suggestBranchName(message)}
                aria-label={t("gitBranchName")}
                aria-invalid={branchProblem ? true : undefined}
                onChange={(e) => setNewBranch(e.target.value)}
              />
              <div className="git-confirm-actions">
                <button className="btn-soft" onClick={branchFirst}>
                  {t("gitProtectedBranch")}
                </button>
                <button className="btn-soft" onClick={() => doPush(true)}>
                  {t("gitProtectedPush", { branch })}
                </button>
                <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                  {t("cancel")}
                </button>
              </div>
              <div className="git-note muted">{t("gitProtectedNote", { branch })}</div>
            </div>
          )}
          {pushNote && (
            <div className="git-note ok" role="status">
              {pushNote}
            </div>
          )}
          {pushError && (
            <>
              <div className="error-box git-error" role="alert">
                {pushError}
              </div>
              {plan.remote && plan.branch && (
                <div className="git-note muted">
                  {t("gitManual", { command: manualPushCommand(plan.remote, plan.branch, plan.setUpstream) })}
                </div>
              )}
            </>
          )}
        </section>
      )}
      {info && !plan.problem && (
        <section className="git-publish-block" aria-label={t("gitPrTitle")}>
          <div className="git-message-head">
            <strong className="grow">{t("gitPrTitle")}</strong>
            {!prOpen && (
              <button className="btn-soft" disabled={busy} onClick={() => setPrOpen(true)}>
                {t("gitPrOpenForm")}
              </button>
            )}
          </div>
          {prOpen && !prUrl && (
            <>
              {(!gh || !gh.installed || !gh.authenticated) && gh && (
                <div className="git-note">
                  {!gh.installed ? t("gitPrGhMissing") : t("gitPrGhSignedOut")}{" "}
                  {t("gitManual", { command: manualPrCommand(base || "main", branch, draft) })}
                </div>
              )}
              <label className="git-field">
                {t("gitPrTitleLabel")}
                <input
                  className="input"
                  value={title}
                  disabled={busy}
                  maxLength={256}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <div className="git-row">
                <label className="git-field grow">
                  {t("gitPrBase")}
                  <select
                    className="input git-select"
                    value={base}
                    disabled={busy || !bases.length}
                    onChange={(e) => setBase(e.target.value)}
                  >
                    {bases.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="git-check">
                  <input type="checkbox" checked={draft} disabled={busy} onChange={(e) => setDraft(e.target.checked)} />{" "}
                  {t("gitPrDraft")}
                </label>
              </div>
              <div>
                <div className="git-message-head">
                  <label htmlFor="git-pr-body" className="grow">
                    {t("gitPrBody")}
                  </label>
                  <button className="btn-soft" disabled={busy || !provider || !plan.remote || !base} onClick={generate}>
                    {generating ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}{" "}
                    {generating ? t("gitGenerating") : body.trim() ? t("gitRegenerate") : t("gitGenerate")}
                  </button>
                </div>
                <textarea
                  id="git-pr-body"
                  className="input git-message"
                  rows={7}
                  value={body}
                  disabled={creating}
                  spellCheck
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t("gitPrBodyPlaceholder")}
                />
              </div>
              {prError && (
                <div className="error-box git-error" role="alert">
                  {prError}
                </div>
              )}
              <div className="git-confirm-actions">
                <span className="git-note muted grow">{problem ? problemText[problem] : t("gitPrNote")}</span>
                <button className="btn btn-primary" disabled={busy || !!problem} onClick={createPr}>
                  {creating && <Loader2 size={13} className="spin" />}{" "}
                  {creating ? t("gitPrCreating") : t("gitPrCreate")}
                </button>
              </div>
            </>
          )}
          {prUrl && (
            <div className="git-pr-link">
              <Check size={14} /> <span className="grow git-path">{prUrl}</span>
              <button className="btn-soft" onClick={openPr}>
                <ExternalLink size={13} /> {t("gitPrOpenLink")}
              </button>
              {chatId && (
                <button
                  className="btn-soft"
                  disabled={watching}
                  onClick={() => {
                    setWatching(true);
                    startPrWatch(chatId, root, prUrl).catch((e) => (setWatching(false), setPrError(errText(e))));
                  }}
                >
                  <Eye size={13} /> {t("prWatchStart")}
                </button>
              )}
            </div>
          )}
          {prUrl && prError && (
            <div className="error-box git-error" role="alert">
              {prError}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
