import { useCallback, useEffect, useRef, useState } from "react";
import { loadAgentSettings } from "../agent/agentSettingsStore";
import { getAdapter } from "../providers";
import { useApp } from "../state";
import { fsx, git, review } from "./api";
import { readProjectFile } from "./projectFolder";
import { assembleReviewRules, NO_RULES, planAutoReview, recordDismissal, stripLineNumbers, withReviewRules, REVIEW_RULES_PATH, AUTO_REVIEW_MAX_CHARS, AUTO_REVIEW_MAX_FILES, type AutoInput, type Dismissal, type ReviewRules } from "./autoReview";
import { buildReviewPrompt, reviewBudget, reviewFromParts, type Finding, type ReviewFile } from "./diffReview";
import { reviewTarget, runsOwnTools } from "./modelRouting";

/** One file to review. Without `load` the diff is the review copy's (`reviewId`); the checkpoint and workspace sources give their own loader. */
export type ReviewTarget = { path: string; reviewId?: string; binary?: boolean; load?: () => Promise<{ diff: string; hunks?: { id: string; header: string }[] }> };
export type StoredFinding = Finding & { reviewId?: string; auto?: boolean };
export type SkipNotice = "tooLarge" | "empty" | "cliModel" | "noModel";
export type ReviewStatus =
  | { phase: "idle" }
  | { phase: "running"; files: number; auto?: boolean }
  | { phase: "done"; files: number; count: number; model: string; auto?: boolean }
  | { phase: "skipped"; reason: SkipNotice; chars?: number; limit?: number; files?: number; auto?: boolean }
  | { phase: "error"; message: string; auto?: boolean };
export type RunOutcome = "done" | "skipped" | "error" | "busy";

let seq = 0;

/** The project's `.gustaf/REVIEW.md` (else the legacy `.mcode/REVIEW.md`; read through the project-root-confined file reader; missing or unreadable means no rules). */
export async function loadReviewRules(root: string): Promise<ReviewRules> {
  try {
    const file = await readProjectFile((path) => fsx.read(root, path), REVIEW_RULES_PATH);
    const read = stripLineNumbers(file.value);
    const cutByReader = /\n…\[truncated\]$/.test(read);
    const rules = assembleReviewRules(read.replace(/\n…\[truncated\]$/, ""), undefined, file.path);
    return cutByReader && rules.status === "loaded" ? { ...rules, status: "truncated" } : rules;
  } catch { return NO_RULES; }
}

/** Which of `paths` the repository's .gitignore ignores (best effort: no repository or an error means none). */
async function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  try { return new Set((await git(root, ["check-ignore", "--", ...paths])).split("\n").map((l) => l.trim()).filter(Boolean)); } catch { return new Set(); }
}

/**
 * Runs the read-only AI review over the pending files: one model turn without tools, the diff as bounded JSON data
 * (lib/diffReview.ts) plus the project's `.gustaf/REVIEW.md` rules in the system prompt. Uses the `review` model or the cheap
 * model from the agent settings when configured, else the chat's selected model; usage goes through the app's counters so
 * budgets see it. Nothing is applied: the result is findings to look at. An automatic run (`auto`) additionally never
 * sends binary, ignored or secret-looking files, redacts the diff and skips above a size cap; every failure is a status, never a throw.
 */
export function useDiffReview(root: string) {
  const app = useApp();
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [summary, setSummary] = useState("");
  const [dismissals, setDismissals] = useState<Map<string, Dismissal>>(new Map());
  const [status, setStatus] = useState<ReviewStatus>({ phase: "idle" });
  const [rules, setRules] = useState<ReviewRules>(NO_RULES);
  const ctl = useRef<{ c: AbortController; auto: boolean } | null>(null);
  const live = useRef({ findings: [] as StoredFinding[], dismissals: new Map<string, Dismissal>() });
  live.current = { findings, dismissals };
  // Latest values for callbacks that outlive a render (the automatic trigger calls `run` from timers and promises).
  const appRef = useRef(app);
  appRef.current = app;

  useEffect(() => () => ctl.current?.c.abort(), []);
  useEffect(() => {
    ctl.current?.c.abort(); ctl.current = null;
    setFindings([]); setSummary(""); setDismissals(new Map()); setStatus({ phase: "idle" }); setRules(NO_RULES);
    let gone = false;
    loadReviewRules(root).then((r) => { if (!gone) setRules(r); });
    return () => { gone = true; };
  }, [root]);

  const run = useCallback(async (targets: ReviewTarget[], opts: { auto?: boolean } = {}): Promise<RunOutcome> => {
    const auto = opts.auto === true;
    const app = appRef.current;
    const selection = app.selection;
    const provider = app.providers.find((p) => p.id === selection?.providerId);
    if (!targets.length || !provider || !selection || ctl.current) return "busy";
    const c = new AbortController();
    ctl.current = { c, auto };
    const skip = (s: Extract<ReviewStatus, { phase: "skipped" }>) => { setStatus(s); return "skipped" as const; };
    try {
      const target = reviewTarget(await loadAgentSettings(), app, { provider, model: selection.model });
      if (auto && runsOwnTools(target.provider)) return skip({ phase: "skipped", reason: "cliModel", auto });
      if (auto && targets.length > AUTO_REVIEW_MAX_FILES) return skip({ phase: "skipped", reason: "tooLarge", files: targets.length, limit: AUTO_REVIEW_MAX_CHARS, auto });
      setStatus({ phase: "running", files: targets.length, auto });
      const loaded = await Promise.all(targets.map(async (t) => {
        if (t.load) return { path: t.path, binary: t.binary, ...(await t.load()) };
        return {
          path: t.path, binary: t.binary,
          diff: await review.diff(t.reviewId!, t.path),
          hunks: (await review.hunks(t.reviewId!, t.path).catch(() => [])).map((h) => ({ id: h.id, header: h.header })),
        };
      }));
      if (c.signal.aborted) return "skipped";
      let files: ReviewFile[] = loaded.map((f) => ({ path: f.path, diff: f.diff, hunks: f.hunks }));
      let sendTargets = targets;
      const budget = reviewBudget(target.info?.contextWindow);
      if (auto) {
        const input: AutoInput[] = loaded.map((f) => ({ path: f.path, diff: f.diff, binary: f.binary, hunks: f.hunks }));
        const plan = planAutoReview(input, { maxChars: Math.min(AUTO_REVIEW_MAX_CHARS, budget), ignored: await ignoredPaths(root, input.map((f) => f.path)) });
        if (c.signal.aborted) return "skipped";
        if (plan.tooLarge) return skip({ phase: "skipped", reason: "tooLarge", chars: plan.chars, limit: Math.min(AUTO_REVIEW_MAX_CHARS, budget), files: plan.count, auto });
        if (plan.empty) return skip({ phase: "skipped", reason: "empty", auto });
        files = plan.files;
        const keep = new Set(files.map((f) => f.path));
        sendTargets = targets.filter((t) => keep.has(t.path));
      } else {
        files = files.filter((f) => f.diff.trim());
        sendTargets = targets.filter((t) => files.some((f) => f.path === t.path));
        if (!files.length) return skip({ phase: "skipped", reason: "empty", auto });
      }
      const rulesNow = await loadReviewRules(root);
      setRules(rulesNow);
      const prompt = buildReviewPrompt(files, budget);
      const adapter = await getAdapter(target.provider);
      app.bumpUsage(target.provider.id);
      const out = await adapter.turn({
        system: withReviewRules(prompt.system, rulesNow), messages: [{ role: "user", parts: [{ type: "text", text: prompt.user }] }],
        tools: [], model: target.model, cwd: root, access: "readonly", signal: c.signal, onText: () => {},
      });
      app.recordTokens(target.provider.id, target.model, out.usage);
      if (c.signal.aborted) return "skipped";
      const result = reviewFromParts(out.parts, sendTargets.map((t) => t.path));
      if (!result.ok) throw new Error("unparsable");
      const reviewOf = new Map(sendTargets.map((t) => [t.path, t.reviewId]));
      const stamp = ++seq;
      const fresh: StoredFinding[] = result.findings.map((f) => ({ ...f, id: `${stamp}-${f.id}`, reviewId: reviewOf.get(f.file), ...(auto ? { auto: true } : {}) }));
      const next = [...live.current.findings.filter((f) => !reviewOf.has(f.file)), ...fresh];
      live.current.findings = next;
      setFindings(next);
      setSummary(result.summary);
      setStatus({ phase: "done", files: sendTargets.length, count: fresh.length, model: target.info?.name ?? target.model, auto });
      return "done";
    } catch (e: any) {
      if (!c.signal.aborted) setStatus({ phase: "error", message: e?.message === "unparsable" ? "unparsable" : String(e?.message ?? e), auto });
      return "error";
    } finally {
      if (ctl.current?.c === c) ctl.current = null;
    }
  }, [root]);

  const cancel = useCallback(() => { ctl.current?.c.abort(); ctl.current = null; setStatus({ phase: "idle" }); }, []);
  /** Aborts only a review the automatic trigger started (a manual one belongs to the user). */
  const cancelAuto = useCallback(() => { if (ctl.current?.auto) { ctl.current.c.abort(); ctl.current = null; setStatus({ phase: "idle" }); } }, []);
  /** Dismisses a finding; the optional reason is kept with it for the session. */
  const dismiss = useCallback((id: string, reason?: string) => {
    const next = recordDismissal(live.current.dismissals, id, reason);
    live.current.dismissals = next;
    setDismissals(next);
  }, []);
  const visible = findings.filter((f) => !dismissals.has(f.id));
  return {
    findings: visible, summary, status, rules, run, cancel, cancelAuto, dismiss, dismissals, running: status.phase === "running",
    /** The visible findings right now, also from inside a callback that started before the last render. */
    current: () => live.current.findings.filter((f) => !live.current.dismissals.has(f.id)),
  };
}
