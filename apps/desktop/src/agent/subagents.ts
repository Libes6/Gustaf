import { review } from "../lib/api";
import { prepareShadowCopy } from "../lib/reviewSetupStore";
import { textOf, type Adapter, type Msg, type Part, type TokenUsage, type ToolDef } from "../providers/types";
import { summarizeCall } from "./actionLog";
import { createRun, getRun, loadPreviousRun, recordAgentTokens, recordMessage, recordStep, updateRun } from "./agentRuns";
import { clip, runTokens, MAX_SUMMARY, type RunStatus } from "./agentRunsModel";
import { canContinue, continuationPrompt, type PreviousRun } from "./agentTranscript";
import { currentBudgetStop } from "../lib/budgetUsage";
import { allowedRefs, refKey, sameRef, selectModel, type AgentSettings, type ModelRef } from "./agentSettings";
import { loadAgentSettings } from "./agentSettingsStore";
import { runAgent, type RunOptions } from "./agent";
import { DELEGATE_TOOL_NAME, delegateToolFor, dependencyContext, mergeReports, parsePlanArgs, runPlan, runWithRetries, type Outcome } from "./orchestrator";
import { Scheduler, isAbortError } from "./scheduler";
import {
  MAX_TITLE, SPAWN_TOOL_NAME, allowedToolNames, breachMessage, budgetBreach, budgetStopMessage, buildReport, findOverlaps, isReadOnlyType, overlapWarning, parseSpawnArgs, resolveBudget, spawnToolFor, subagentSystem,
  type BudgetBreach, type BudgetOverrides, type BudgetScope, type FileSet, type SpawnArgs,
} from "./subagentCore";

// Subagent runtime: `spawn_agent` runs a separate runAgent loop (own history, own tool allowlist and budget, model from
// the agent settings or the parent's) and hands the parent a bounded report; `delegate_tasks` runs a plan of such tasks
// with dependencies and write ownership (orchestrator.ts) and returns one merged summary. Pure parts are in
// subagentCore.ts, agentSettings.ts, orchestrator.ts and scheduler.ts.

export type SubagentHost = {
  /** The agent tools offered to the main loop (spawn_agent, delegate_tasks), with the allowed models named. */
  tools(parent: ModelRef): Promise<ToolDef[]>;
  handles(name: string): boolean;
  /** Runs an agent tool call. Rejects only for invalid arguments. */
  call(name: string, args: unknown, parent: RunOptions): Promise<string>;
  /** Runs one subagent to completion (waiting for a free slot first) and returns its report. Rejects only for invalid arguments. */
  spawn(args: unknown, parent: RunOptions): Promise<string>;
  /** Runs a delegate_tasks plan and returns the merged summary. Rejects only for an invalid plan. */
  delegate(args: unknown, parent: RunOptions): Promise<string>;
};

/** What a subagent needs to run on another model than the parent's. `null` = not usable for subagents. */
export type ResolvedModel = { adapter: Adapter; supportsTools?: boolean } | null;

export type HostConfig = {
  /** The original project folder; writing subagents get their shadow copy of it. */
  projectRoot: string;
  recordTokens: (providerId: string, model: string, usage?: TokenUsage) => void;
  scheduler?: Scheduler;
  /** Budget overrides; default: the per-type budgets from the agent settings. */
  budgets?: BudgetOverrides;
  /** Agent settings; default: the stored ones (agentSettingsStore). */
  settings?: AgentSettings;
  /** Resolves a configured model to an adapter; without it subagents always use the parent's model. */
  resolveModel?: (ref: ModelRef) => Promise<ResolvedModel>;
  prepare?: typeof prepareShadowCopy;
  now?: () => number;
  /** Which user token budget (day or chat) is exceeded now; default: read from the Budgets settings and usage. Only consulted when `stopOnBudget` is on. */
  checkBudget?: (chatId: number | undefined) => Promise<BudgetScope | null>;
  /** What a "continue this agent" run is seeded with; default: the stored run and transcript. */
  previousRun?: (id: string) => Promise<PreviousRun | null>;
  /** Pause before a delegate_tasks retry (ms, by retry number); default 1 s, then 3 s. */
  retryBackoffMs?: (retry: number) => number;
};

type Result = { status: RunStatus; report: string };
type Runner = { adapter: Adapter; providerId: string; model: string; supportsTools?: boolean; note?: string };

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

  const settingsNow = async () => cfg.settings ?? (await loadAgentSettings());
  const parentRef = (p: Pick<RunOptions, "providerId" | "model">): ModelRef => ({ providerId: p.providerId, model: p.model });

  /** The chosen model as something runnable; an unusable model falls back to the parent's with a note. */
  async function runnerFor(ref: ModelRef, parent: RunOptions): Promise<Runner> {
    const own: Runner = { adapter: parent.adapter, providerId: parent.providerId, model: parent.model, supportsTools: parent.supportsTools };
    if (sameRef(ref, parentRef(parent))) return own;
    const r = cfg.resolveModel ? await cfg.resolveModel(ref).catch(() => null) : null;
    if (!r || r.supportsTools === false) return { ...own, note: `Model ${refKey(ref)} is not available for subagents (missing, disabled, a CLI provider or without tool support); used ${refKey(parentRef(parent))}.` };
    return { adapter: r.adapter, providerId: ref.providerId, model: ref.model, supportsTools: r.supportsTools };
  }

  /** Picks the model (explicit request from the allow-list, type default, parent). Throws for a model that is not allowed. */
  function chooseModel(args: SpawnArgs, settings: AgentSettings, parent: RunOptions): ModelRef {
    const choice = selectModel(args.type, settings, parentRef(parent), args.model);
    if (!choice.ok) throw new Error(choice.error);
    return choice.ref;
  }

  /** The exceeded budget while `stopOnBudget` is on, else null. A failing check never stops anything. */
  async function overBudget(settings: AgentSettings, parent: Pick<RunOptions, "chatId">): Promise<BudgetScope | null> {
    if (!settings.stopOnBudget) return null;
    return (await (cfg.checkBudget ?? currentBudgetStop)(parent.chatId).catch(() => null)) ?? null;
  }

  /** `continue_from`: the prompt becomes the previous run's summary plus the follow-up. */
  async function seeded(args: SpawnArgs): Promise<SpawnArgs> {
    if (!args.continueFrom) return args;
    const prev = await (cfg.previousRun ?? loadPreviousRun)(args.continueFrom).catch(() => null);
    if (!prev) throw new Error(`continue_from: there is no subagent run "${args.continueFrom}".`);
    if (!canContinue(prev.status)) throw new Error(`continue_from: run "${args.continueFrom}" is ${prev.status}; only finished, failed or limit-stopped runs can be continued.`);
    return { ...args, prompt: continuationPrompt(prev, args.prompt) };
  }

  async function spawn(rawArgs: unknown, parent: RunOptions): Promise<string> {
    const parsed = parseSpawnArgs(rawArgs);
    if (!parsed.ok) throw new Error(parsed.error);
    const settings = await settingsNow();
    const over = await overBudget(settings, parent);
    if (over) throw new Error(`Subagent not started: ${budgetStopMessage(over)}.`);
    const args = await seeded(parsed.value);
    const ref = chooseModel(args, settings, parent);
    return (await runTask(args, ref, settings, parent)).report;
  }

  async function delegate(rawArgs: unknown, parent: RunOptions): Promise<string> {
    const settings = await settingsNow();
    const parsed = parsePlanArgs(rawArgs, { cancelDependents: settings.cancelDependents });
    if (!parsed.ok) throw new Error(parsed.error);
    const plan = parsed.value;
    if (plan.tasks.some((t) => t.continueFrom)) throw new Error("delegate_tasks does not support `continue_from`; use spawn_agent to continue a run.");
    const over = await overBudget(settings, parent);
    if (over) throw new Error(`Plan not started: ${budgetStopMessage(over)}.`);
    // Every model is checked before anything starts: a plan either runs as a whole or not at all.
    const refs = new Map(plan.tasks.map((t) => [t.id, chooseModel(t, settings, parent)]));
    const outcomes = await runPlan(plan, {
      limit: scheduler.concurrency,
      signal: parent.signal,
      run: (task, deps) =>
        // A retry is a fresh run (new private copy for a writing task); the failed attempt's own changes are discarded.
        runWithRetries(
          async (n, last) => {
            const r = await runTask({ ...task, title: n > 1 ? clip(`${task.title} (retry ${n - 1})`, MAX_TITLE) : task.title, prompt: task.prompt + dependencyContext(deps) }, refs.get(task.id)!, settings, parent, { discardIfFailed: !last });
            return { status: r.status === "interrupted" || r.status === "queued" || r.status === "running" ? "failed" : r.status, report: r.report } satisfies Outcome;
          },
          { retries: plan.retries ?? 0, signal: parent.signal, ...(cfg.retryBackoffMs ? { backoffMs: cfg.retryBackoffMs } : {}) },
        ),
    });
    return mergeReports(plan, outcomes);
  }

  async function runTask(args: SpawnArgs, ref: ModelRef, settings: AgentSettings, parent: RunOptions, opts: { discardIfFailed?: boolean } = {}): Promise<Result> {
    const { title, prompt, type, files } = args;
    const writing = !isReadOnlyType(type);
    const budget = resolveBudget(type, cfg.budgets ?? settings.budgets);
    const runner = await runnerFor(ref, parent);
    const sameProvider = runner.providerId === parent.providerId;
    const ctl = new AbortController();
    const onParentAbort = () => ctl.abort();
    parent.signal.addEventListener("abort", onParentAbort, { once: true });
    if (parent.signal.aborted) ctl.abort();
    const id = createRun({ title, type, providerId: runner.providerId, model: runner.model, projectRoot: cfg.projectRoot, ...(parent.chatId !== undefined ? { chatId: parent.chatId } : {}) }, () => ctl.abort());
    recordMessage(id, "user", [{ type: "text", text: prompt }], now());
    if (runner.note) recordStep(id, { at: now(), kind: "note", text: runner.note });
    const finish = (status: RunStatus, patch: Parameters<typeof updateRun>[1] = {}) => updateRun(id, { status, endedAt: now(), currentStep: "", ...patch });

    try {
      return await scheduler.run(() => execute(), ctl.signal);
    } catch (e) {
      // Cancelled while queued (the scheduler rejects with an AbortError) or an unexpected failure outside the run.
      if (isAbortError(e)) {
        finish("cancelled");
        return { status: "cancelled", report: buildReport({ title, type, status: "cancelled", text: "Cancelled before it started." }) };
      }
      const message = String((e as Error)?.message ?? e);
      finish("failed", { error: clip(message, 1000) });
      return { status: "failed", report: buildReport({ title, type, status: "failed", text: "", reason: message }) };
    } finally {
      parent.signal.removeEventListener("abort", onParentAbort);
    }

    async function execute(): Promise<Result> {
      const startedAt = now();
      const stopped = await overBudget(settings, parent);
      if (stopped) {
        const reason = budgetStopMessage(stopped);
        finish("budget", { error: clip(`Not started: ${reason}`, 1000) });
        recordStep(id, { at: now(), kind: "note", text: `Not started: ${reason}.`, error: true });
        return { status: "budget", report: buildReport({ title, type, status: "budget", text: "", reason: `not started, ${reason}` }) };
      }
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
            approve: (command) => parent.approve({ kind: "command", command, agent: title }).then(Boolean),
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
        return { status: "failed", report: buildReport({ title, type, status: "failed", text: "", reason: `could not prepare a private copy: ${message}` }) };
      }

      const use = { steps: 0, toolCalls: 0, tokens: 0, startedAt };
      let stopReason = null as BudgetBreach | null;
      let overScope = null as BudgetScope | null;
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

      let gateNote = "";
      try {
        const outcome = await runAgent({
          root: workspace,
          reviewMode,
          reviewLinked: linked,
          supportsTools: runner.supportsTools,
          history: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
          adapter: runner.adapter,
          providerId: runner.providerId,
          model: runner.model,
          // Reasoning level and quota windows belong to the parent's provider.
          reasoning: sameProvider ? parent.reasoning : undefined,
          access: writing ? parent.access : "readonly",
          computerUse: false,
          allowlist: parent.allowlist,
          signal: ctl.signal,
          maxSteps: budget.maxSteps,
          toolNames: allowedToolNames(type),
          systemExtra: subagentSystem(type, files),
          subagent: true,
          onLimits: sameProvider ? parent.onLimits : undefined,
          onText: () => {},
          approve: async (req) => {
            // Shown in the panel while it waits (the chat's approval card and sidebar badge come from the parent's approve).
            recordStep(id, null, {}, "Waiting for approval");
            try {
              return await parent.approve({ ...req, agent: title });
            } finally {
              recordStep(id, null, {}, "");
            }
          },
          onMessage: async (m) => {
            lastRole = m.role;
            recordMessage(id, m.role, m.parts, now());
            if (m.role === "assistant") {
              const usage = m.meta?.usage;
              use.steps++;
              use.tokens += runTokens(usage);
              recordAgentTokens(parent.chatId, runTokens(usage));
              cfg.recordTokens(runner.providerId, runner.model, usage);
              const calls = m.parts.filter((p): p is ToolCall => p.type === "tool_call");
              use.toolCalls += calls.length;
              const said = textOf(m).trim();
              if (said) lastText = said;
              calls.forEach((c) => pending.set(c.id, c));
              recordStep(id, said ? { at: now(), kind: "text", text: said } : null, { tokens: runTokens(usage), toolUses: calls.length }, calls.length ? `${calls[0].name} ${summarizeCall(calls[0].name, calls[0].args)}`.trim() : "");
              const breach = budgetBreach(use, budget, now());
              if (breach) stopFor(breach);
              // The user's own token budget is checked at every step boundary too.
              else if (!stopReason && (overScope = await overBudget(settings, parent))) stopFor("budget");
            } else if (m.role === "tool") {
              for (const r of m.parts.filter((p): p is ToolResult => p.type === "tool_result")) {
                const c = pending.get(r.id);
                pending.delete(r.id);
                recordStep(id, { at: now(), kind: "tool", tool: r.name, text: c ? summarizeCall(c.name, c.args) : r.name, result: r.output.slice(0, 400), ...(r.isError ? { error: true } : {}) });
              }
            }
          },
        });
        // A verification gate (the project's required checks) that this agent could not satisfy is reported with the run.
        if (outcome?.verification?.outcome === "failed") gateNote = `Failed verification. ${outcome.verification.summary}`;
      } catch (e) {
        if (!(ctl.signal.aborted || isAbortError(e))) failure = String((e as Error)?.message ?? e);
      } finally {
        clearTimeout(timer);
      }
      if (!stopReason && !ctl.signal.aborted && !failure && lastRole === "tool" && use.steps >= budget.maxSteps) stopReason = "steps";
      const status: RunStatus = stopReason === "budget" ? "budget" : stopReason ? "limit" : failure ? "failed" : ctl.signal.aborted ? "cancelled" : "completed";
      const reason = stopReason === "budget" ? budgetStopMessage(overScope ?? "day") : stopReason ? breachMessage(stopReason, budget) : failure;
      const discard = !!opts.discardIfFailed && status === "failed";

      // Changed files (writing agents): the private copy stays as a separate pending review when it has changes.
      let changed: string[] = [];
      const warnings: string[] = [];
      if (reviewId) {
        try {
          const all = await review.list(cfg.projectRoot);
          const sets: FileSet[] = all.map(([r, list]) => ({ id: r.id, label: ownerLabel(r.id), files: list.map((c) => c.path) }));
          const own = sets.find((s) => s.id === reviewId);
          changed = own ? [...own.files] : [];
          if (own && discard) {
            // This attempt will be retried in a fresh copy: its partial changes are not kept as a pending review.
            for (const path of changed) await review.decide(reviewId, path, false).catch(() => {});
            changed = [];
          } else if (own) {
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

      if (runner.note) warnings.push(runner.note);
      if (gateNote) warnings.push(gateNote.slice(0, 600));
      if (stopReason) recordStep(id, { at: now(), kind: "note", text: stopReason === "budget" ? `Stopped: ${reason}.` : `Stopped at its ${reason}.`, error: true });
      const report = buildReport({ title, type, status, text: lastText, reason, changed, warnings });
      finish(status, { summary: clip(lastText, MAX_SUMMARY), report: lastText, ...(failure ? { error: clip(failure, 1000) } : stopReason ? { error: stopReason === "budget" ? `Stopped: ${reason}` : `Stopped at its ${reason}` } : {}), ...(changed.length ? { changed } : {}), ...(warnings.length ? { warnings } : {}) });
      return { status, report };
    }
  }

  const NAMES = new Set([SPAWN_TOOL_NAME, DELEGATE_TOOL_NAME]);
  return {
    async tools(parent) {
      const allowed = allowedRefs(await settingsNow(), parent).map(refKey);
      return [spawnToolFor(allowed), delegateToolFor(allowed)];
    },
    handles: (name) => NAMES.has(name),
    call: (name, args, parent) => (name === DELEGATE_TOOL_NAME ? delegate(args, parent) : spawn(args, parent)),
    spawn,
    delegate,
  };
}

const ownerLabel = (reviewId: string) => {
  const run = getRun(reviewOwners.get(reviewId) ?? "");
  return run ? run.title : "another pending review";
};
