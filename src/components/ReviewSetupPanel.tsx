import { ChevronDown, ChevronRight, Play, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { review } from "../lib/api";
import { commandNeedsApproval } from "../lib/commandRules";
import { hasReviewSetup, normalizeReviewSetup, parseLinkDirs, summarizeRun, TEST_TIMEOUT_MS, type ReviewSetupConfig, type RunSummary } from "../lib/reviewSetup";
import { saveReviewSetup } from "../lib/reviewSetupStore";
import { useApp } from "../state";
import "../styles/reviewSetup.css";

/** Opt-in per-project shadow-copy settings: linked dependency directories, setup command, test command. */
export function ReviewSetupForm({ root, config, onSaved }: { root: string; config: ReviewSetupConfig; onSaved: (c: ReviewSetupConfig) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [dirs, setDirs] = useState(config.linkDirs.join("\n"));
  const [setup, setSetup] = useState(config.setupCommand);
  const [test, setTest] = useState(config.testCommand);
  const [err, setErr] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setDirs(config.linkDirs.join("\n")); setSetup(config.setupCommand); setTest(config.testCommand); }, [config]);
  const next = normalizeReviewSetup({ linkDirs: parseLinkDirs(dirs), setupCommand: setup, testCommand: test });
  const save = async () => {
    setErr(""); setSaved(false);
    try { await saveReviewSetup(root, next); onSaved(next); setSaved(true); } catch (e) { setErr(String(e)); }
  };
  return (
    <div className="rs-box">
      <button className="rs-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Settings2 size={13} />
        <span className="grow">{t("reviewSetupTitle")}</span>
        {!open && hasReviewSetup(config) && <span className="hint">{t("reviewSetupOn")}</span>}
      </button>
      {open && <div className="rs-form">
        <p className="rs-note">{t("reviewSetupIntro")}</p>
        <label>{t("reviewSetupLinks")}
          <textarea className="input" rows={2} value={dirs} placeholder="node_modules" onChange={e => { setDirs(e.target.value); setSaved(false); }} spellCheck={false} />
        </label>
        <p className="rs-note warn">{t("reviewSetupLinksWarn")}</p>
        <label>{t("reviewSetupCommand")}
          <input className="input" value={setup} placeholder="npm ci" onChange={e => { setSetup(e.target.value); setSaved(false); }} spellCheck={false} />
        </label>
        <label>{t("reviewTestCommand")}
          <input className="input" value={test} placeholder="npm test" onChange={e => { setTest(e.target.value); setSaved(false); }} spellCheck={false} />
        </label>
        <p className="rs-note">{t("reviewSetupApproval")}</p>
        {err && <div className="error-box" role="alert" style={{ margin: 0 }}>{err}</div>}
        <div className="rs-row">
          <button className="btn-soft" onClick={save}>{t("save")}</button>
          {saved && <span className="hint" role="status">{t("reviewSetupSaved")}</span>}
        </div>
      </div>}
    </div>
  );
}

// Results survive the panel being collapsed or the chat being switched; they belong to one shadow copy and one point in time (`tick`).
const lastRuns = new Map<string, { run: RunSummary; tick: number }>();

/** Runs the project's test command inside one shadow copy and shows exit code and truncated output before accepting. */
export function ReviewTestRun({ reviewId, command, tick, busy }: { reviewId: string; command: string; tick: number; busy: boolean }) {
  const t = useT();
  const app = useApp();
  const [result, setResult] = useState(lastRuns.get(reviewId) ?? null);
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setResult(lastRuns.get(reviewId) ?? null); setConfirm(false); }, [reviewId]);
  const run = async () => {
    setConfirm(false); setErr(""); setRunning(true);
    try {
      const entry = { run: summarizeRun(command, await review.run(reviewId, command, TEST_TIMEOUT_MS)), tick };
      lastRuns.set(reviewId, entry);
      setResult(entry);
    } catch (e: any) { setErr(String(e?.message ?? e)); } finally { setRunning(false); }
  };
  // Same rule as the agent's run_command: "Ask for commands" mode asks unless the command is allowlisted.
  const start = () => { if (commandNeedsApproval(app.access, command, app.allowlist)) setConfirm(true); else run(); };
  const shown = result && result.run.command === command ? result : null;
  const status = shown ? (shown.run.timedOut ? t("reviewTimedOut") : shown.run.ok ? t("reviewTestsPassed") : t("reviewTestsFailed", { code: String(shown.run.code ?? "?") })) : "";
  return (
    <div className="rs-test">
      <div className="rs-row">
        <Play size={13} />
        <code className="grow" title={command}>{command}</code>
        <button className="btn-soft" disabled={busy || running || confirm} onClick={start}>{running ? t("reviewTestsRunning") : t("reviewRunTests")}</button>
      </div>
      {confirm && <div className="rs-row" role="alertdialog" aria-label={t("approveCommand")}>
        <span className="grow">{t("reviewRunApprove")}</span>
        <button className="btn-soft" onClick={run}>{t("reviewRunTests")}</button>
        <button className="btn-ghost btn" onClick={() => setConfirm(false)}>{t("cancel")}</button>
      </div>}
      {err && <div className="error-box" role="alert" style={{ margin: 0 }}>{err}</div>}
      {shown && <>
        <div className="rs-row" role="status">
          <span className={`rs-status ${shown.run.ok ? "ok" : "bad"}`}>{status}</span>
          {shown.tick !== tick && <span className="rs-status stale">{t("reviewTestsStale")}</span>}
        </div>
        {shown.run.output && <pre className="rs-output">{shown.run.output}</pre>}
      </>}
    </div>
  );
}
