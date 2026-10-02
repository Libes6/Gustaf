import { review } from "../lib/api";
import { prepareShadowCopy } from "../lib/reviewSetupStore";
import { textOf, type Msg, type Part, type TokenUsage } from "../providers/types";
import { summarizeCall } from "./actionLog";
import { createRun, recordStep, updateRun, getRun } from "./agentRuns";
import { clip, runTokens, MAX_SUMMARY, type RunStatus } from "./agentRunsModel";
import { runAgent, type RunOptions } from "./agent";
import { Scheduler, isAbortError } from "./scheduler";
import {
  allowedToolNames, breachMessage, budgetBreach, buildReport, findOverlaps, isReadOnlyType, overlapWarning, parseSpawnArgs, resolveBudget, subagentSystem,
  type BudgetBreach, type BudgetOverrides, type FileSet,
} from "./subagentCore";

// Subagent runtime: `spawn_agent` runs a separate runAgent loop (own history, own tool allowlist and budget, same
// provider/model as the parent) and hands the parent a bounded report. Pure parts are in subagentCore.ts and scheduler.ts.

export type SubagentHost = {
  /** Runs one subagent to completion (waiting for a free slot first) and returns its report. Rejects only for invalid arguments. */
  spawn(args: unknown, parent: RunOptions): Promise<string>;
};

export type HostConfig = {
  /** The original project folder; writing subagents get their shadow copy of it. */
  projectRoot: string;
  recordTokens: (providerId: string, model: string, usage?: TokenUsage) => void;
  scheduler?: Scheduler;
  budgets?: BudgetOverrides;
  prepare?: typeof prepareShadowCopy;
  now?: () => number;
};

/** One limit for the whole app: several chats share the slots. */
export const globalScheduler = new Scheduler();

/** Review copy id -> the run that owns it, to name an overlapping review in warnings. */
const reviewOwners = new Map<string, string>();

type ToolCall = Extract<Part, { type: "tool_call" }>;
type ToolResult = Extract<Part, { type: "tool_result" }>;

export function createSubagentHost(cfg: HostConfig): SubagentHost {
  const scheduler = cfg.scheduler ?? globalScheduler;
  const now = cfg.now ?? Date.now;
  const prepare = cfg.prepare ?? prepareShadowCopy;

  async function spawn(rawArgs: unknown, parent: RunOptions): Promise<string> {
    const parsed = parseSpawnArgs(rawArgs);
    if (!parsed.ok) throw new Error(parsed.error);
    const { title, prompt, type, files } = parsed.value;
    const writing = !isReadOnlyType(type);
    const budget = resolveBudget(type, cfg.budgets);
    const ctl = new AbortController();
    const onParentAbort = () => ctl.abort();
    parent.signal.addEventListener("abort", onParentAbort, { once: true });
    if (parent.signal.aborted) ctl.abort();
    const id = createRun({ title, type, providerId: parent.providerId, model: parent.model, projectRoot: cfg.projectRoot }, () => ctl.abort());
    const finish = (status: RunStatus, patch: Parameters<typeof updateRun>[1] = {}) => updateRun(id, { status, endedAt: now(), currentStep: "", ...patch });

    try {
      return await scheduler.run(() => execute(), ctl.signal);
    } catch (e) {
      // Cancelled while queued (the scheduler rejects with an AbortError) or an unexpected failure outside the run.
      if (isAbortError(e)) {
        finish("cancelled");
        return buildReport({ title, type, status: "cancelled", text: "Cancelled before it started." });
      }
      const message = String((e as Error)?.message ?? e);
      finish("failed", { error: clip(message, 1000) });
      return buildReport({ title, type, status: "failed", text: "", reason: message });
    } finally {
      parent.signal.removeEventListener("abort", onParentAbort);
    }

    async function execute(): Promise<string> {
      const startedAt = now();
      updateRun(id, { status: "running", startedAt });
      let workspace = parent.root;
      let reviewId: string | undefined;
      let linked = parent.reviewLinked;
      let reviewMode = !!parent.reviewMode;
      try {
        if (writing) {
          const made = await prepare(cfg.projectRoot, {
            access: parent.access,
            allowlist: parent.allowlist,
            approve: (command) => parent.approve({ kind: "command", command, agent: title }),
          });
          reviewId = made.review.id;
          reviewOwners.set(reviewId, id);
          workspace = made.review.workspace;
          linked = made.review.linked;
          reviewMode = true;
          if (made.setup === "declined") recordStep(id, { at: now(), kind: "note", text: "Setup command was not run (declined or blocked)." });
          else if (made.setup && !made.setup.ok) recordStep(id, { at: now(), kind: "note", text: "Setup command failed; the copy may lack dependencies.", error: true });
        }
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        finish("failed", { error: clip(message, 1000) });
        return buildReport({ title, type, status: "failed", text: "", reason: `could not prepare a private copy: ${message}` });
      }

      const use = { steps: 0, toolCalls: 0, tokens: 0, startedAt };
      let stopReason = null as BudgetBreach | null;
      let lastText = "";
      let lastRole = "user" as Msg["role"];
      let failure = "";
      const pending = new Map<string, ToolCall>();
      const stopFor = (why: BudgetBreach) => {
        if (stopReason) return;
        stopReason = why;
        ctl.abort();
      };
      const timer = setTimeout(() => stopFor("time"), budget.maxMs);

      try {
        await runAgent({
          root: workspace,
          reviewMode,
          reviewLinked: linked,
          supportsTools: parent.supportsTools,
          history: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
          adapter: parent.adapter,
          providerId: parent.providerId,
          model: parent.model,
          reasoning: parent.reasoning,
          access: writing ? parent.access : "readonly",
          computerUse: false,
          allowlist: parent.allowlist,
          signal: ctl.signal,
          maxSteps: budget.maxSteps,
          toolNames: allowedToolNames(type),
          systemExtra: subagentSystem(type, files),
          onLimits: parent.onLimits,
          onText: () => {},
          approve: (req) => parent.approve({ ...req, agent: title }),
          onMessage: async (m) => {
            lastRole = m.role;
            if (m.role === "assistant") {
              const usage = m.meta?.usage;
              use.steps++;
              use.tokens += runTokens(usage);
              cfg.recordTokens(parent.providerId, parent.model, usage);
              const calls = m.parts.filter((p): p is ToolCall => p.type === "tool_call");
              use.toolCalls += calls.length;
              const said = textOf(m).trim();
              if (said) lastText = said;
              calls.forEach((c) => pending.set(c.id, c));
              recordStep(id, said ? { at: now(), kind: "text", text: said } : null, { tokens: runTokens(usage), toolUses: calls.length }, calls.length ? `${calls[0].name} ${summarizeCall(calls[0].name, calls[0].args)}`.trim() : "");
              const breach = budgetBreach(use, budget, now());
              if (breach) stopFor(breach);
            } else if (m.role === "tool") {
              for (const r of m.parts.filter((p): p is ToolResult => p.type === "tool_result")) {
                const c = pending.get(r.id);
                pending.delete(r.id);
                recordStep(id, { at: now(), kind: "tool", tool: r.name, text: c ? summarizeCall(c.name, c.args) : r.name, result: r.output.slice(0, 400), ...(r.isError ? { error: true } : {}) });
              }
            }
          },
        });
      } catch (e) {
        if (!(ctl.signal.aborted || isAbortError(e))) failure = String((e as Error)?.message ?? e);
      } finally {
        clearTimeout(timer);
      }
      if (!stopReason && !ctl.signal.aborted && !failure && lastRole === "tool" && use.steps >= budget.maxSteps) stopReason = "steps";

      // Changed files (writing agents): the private copy stays as a separate pending review when it has changes.
      let changed: string[] = [];
      const warnings: string[] = [];
      if (reviewId) {
        try {
          const all = await review.list(cfg.projectRoot);
          const sets: FileSet[] = all.map(([r, list]) => ({ id: r.id, label: ownerLabel(r.id), files: list.map((c) => c.path) }));
          const own = sets.find((s) => s.id === reviewId);
          changed = own ? [...own.files] : [];
          if (own) {
            const overlaps = findOverlaps(own, sets);
            const warning = overlapWarning(overlaps);
            if (warning) warnings.push(warning);
            // Tell agents that finished earlier that this one now overlaps with them.
            for (const o of overlaps) {
              const owner = reviewOwners.get(o.id);
              const run = owner ? getRun(owner) : undefined;
              if (run && owner && owner !== id) updateRun(owner, { warnings: [...(run.warnings ?? []), overlapWarning([{ id, label: title, files: o.files }])].slice(-10) });
            }
          }
        } catch {
          warnings.push("Could not check for overlapping changes.");
        }
        await review.finish(reviewId).catch(() => {});
      }

      const status: RunStatus = stopReason ? "limit" : failure ? "failed" : ctl.signal.aborted ? "cancelled" : "completed";
      const reason = stopReason ? breachMessage(stopReason, budget) : failure;
      const report = buildReport({ title, type, status, text: lastText, reason, changed, warnings });
      finish(status, { summary: clip(lastText, MAX_SUMMARY), ...(failure ? { error: clip(failure, 1000) } : stopReason ? { error: `Stopped at its ${reason}` } : {}), ...(changed.length ? { changed } : {}), ...(warnings.length ? { warnings } : {}) });
      return report;
    }
  }

  return { spawn };
}

const ownerLabel = (reviewId: string) => {
  const run = getRun(reviewOwners.get(reviewId) ?? "");
  return run ? run.title : "another pending review";
};
