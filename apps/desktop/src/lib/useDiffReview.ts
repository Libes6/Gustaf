import { useCallback, useEffect, useRef, useState } from "react";
import { loadAgentSettings } from "../agent/agentSettingsStore";
import { getAdapter } from "../providers";
import { useApp } from "../state";
import { review } from "./api";
import { buildReviewPrompt, reviewBudget, reviewFromParts, type Finding } from "./diffReview";
import { cheapTarget } from "./modelRouting";

export type ReviewTarget = { reviewId: string; path: string };
export type StoredFinding = Finding & { reviewId: string };
export type ReviewStatus =
  | { phase: "idle" }
  | { phase: "running"; files: number }
  | { phase: "done"; files: number; count: number; model: string }
  | { phase: "error"; message: string };

let seq = 0;

/**
 * Runs the read-only AI review over the pending files: one model turn without tools, the diff as bounded JSON data
 * (lib/diffReview.ts). Uses the cheap model from the agent settings when configured, else the chat's selected model;
 * usage goes through the app's counters so budgets see it. Nothing is applied: the result is findings to look at.
 */
export function useDiffReview(root: string) {
  const app = useApp();
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [summary, setSummary] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<ReviewStatus>({ phase: "idle" });
  const ctl = useRef<AbortController | null>(null);

  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => { ctl.current?.abort(); setFindings([]); setSummary(""); setDismissed(new Set()); setStatus({ phase: "idle" }); }, [root]);

  const run = useCallback(async (targets: ReviewTarget[]) => {
    const selection = app.selection;
    const provider = app.providers.find((p) => p.id === selection?.providerId);
    if (!targets.length || !provider || !selection || ctl.current) return;
    const c = new AbortController();
    ctl.current = c;
    setStatus({ phase: "running", files: targets.length });
    try {
      const target = cheapTarget(await loadAgentSettings(), app, { provider, model: selection.model });
      const files = await Promise.all(targets.map(async (t) => ({
        path: t.path,
        diff: await review.diff(t.reviewId, t.path),
        hunks: (await review.hunks(t.reviewId, t.path).catch(() => [])).map((h) => ({ id: h.id, header: h.header })),
      })));
      const { system, user } = buildReviewPrompt(files, reviewBudget(target.info?.contextWindow));
      const adapter = await getAdapter(target.provider);
      app.bumpUsage(target.provider.id);
      const out = await adapter.turn({
        system, messages: [{ role: "user", parts: [{ type: "text", text: user }] }],
        tools: [], model: target.model, cwd: root, access: "readonly", signal: c.signal, onText: () => {},
      });
      app.recordTokens(target.provider.id, target.model, out.usage);
      if (c.signal.aborted) return;
      const result = reviewFromParts(out.parts, targets.map((t) => t.path));
      if (!result.ok) throw new Error("unparsable");
      const reviewOf = new Map(targets.map((t) => [t.path, t.reviewId]));
      const stamp = ++seq;
      const fresh = result.findings.map((f) => ({ ...f, id: `${stamp}-${f.id}`, reviewId: reviewOf.get(f.file)! }));
      setFindings((old) => [...old.filter((f) => !reviewOf.has(f.file)), ...fresh]);
      setSummary(result.summary);
      setStatus({ phase: "done", files: targets.length, count: fresh.length, model: target.info?.name ?? target.model });
    } catch (e: any) {
      if (!c.signal.aborted) setStatus({ phase: "error", message: e?.message === "unparsable" ? "unparsable" : String(e?.message ?? e) });
    } finally {
      if (ctl.current === c) ctl.current = null;
    }
  }, [app, root]);

  const cancel = useCallback(() => { ctl.current?.abort(); ctl.current = null; setStatus({ phase: "idle" }); }, []);
  const dismiss = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), []);
  const visible = findings.filter((f) => !dismissed.has(f.id));
  return { findings: visible, summary, status, run, cancel, dismiss, running: status.phase === "running" };
}
