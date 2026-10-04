import { review } from "../lib/api";
import { prepareShadowCopy } from "../lib/reviewSetupStore";
import { textOf, type Adapter, type CliId, type Msg, type Part, type TokenUsage, type ToolDef } from "../providers/types";
import { summarizeCall } from "./actionLog";
import { createRun, getRun, loadPreviousRun, recordAgentTokens, recordMessage, recordStep, updateRun } from "./agentRuns";
import { clip, runTokens, MAX_SUMMARY, type RunStatus } from "./agentRunsModel";
import { canContinue, continuationPrompt, type PreviousRun } from "./agentTranscript";
import { currentBudgetStop } from "../lib/budgetUsage";
import { allowedProviderIds, allowedRefs, refKey, sameRef, selectFallbacks, selectModel, selectProviderRoute, type AgentSettings, type ModelRef, type ProviderLite } from "./agentSettings";
import { loadAgentSettings } from "./agentSettingsStore";
import { runAgent, type RunOptions } from "./agent";
import { DELEGATE_TOOL_NAME, delegateToolFor, dependencyContext, mergeReports, parsePlanArgs, runPlan, runWithRetries, type Outcome } from "./orchestrator";
import { Scheduler, isAbortError } from "./scheduler";
import { activityLabel, activityStep, chainIndex, classifyCliFailure, cliAccess, cliSubagentSystem, createCliCollector, movesToFallback, type CliFailure, type CliFailureKind, type SubagentWorkspace, type SubagentWorktrees } from "./cliSubagentCore";
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

/** A provider a task named (`provider`, `role`, `fallbackProviders`) as something that can run it: an API model, or a CLI agent that runs its own tools. */
export type ResolvedProvider =
  | { ok: true; kind: "api"; adapter: Adapter; supportsTools?: boolean; model: string; name: string }
  | { ok: true; kind: "cli"; adapter: Adapter; cli: CliId; model: string; name: string }
  | { ok: false; reason: string };
/** The enabled providers and how to run a task on one (modelRouting.ts `providerDirectory`). */
export type ProviderDirectory = {
  list(): ProviderLite[];
  /** `model` absent: the provider's default (a CLI's own default model, else the first listed model with tool support). */
  resolve(providerId: string, model?: string): Promise<ResolvedProvider>;
};

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
  /** Providers a task may name. Without it `provider`, `role` and `fallbackProviders` are refused. */
  providers?: ProviderDirectory;
  /** git worktrees for CLI subagents that write; default: the real ones (lib/subagentWorktrees.ts). */
  worktrees?: SubagentWorktrees;
  /** A CLI subagent failed with a quota, rate limit or sign-in error (the app may park that account, for example in the Cursor pool). Never throws into the run. */
  onCliFailure?: (info: { providerId: string; failure: CliFailure; message: string }) => void | Promise<void>;
};

type Result = { status: RunStatus; report: string; /** Set when a CLI subagent failed: why (the next attempt may move to a fallback provider). */ failure?: CliFailureKind };
type Runner = { adapter: Adapter; providerId: string; model: string; supportsTools?: boolean; note?: string; /** Set for a CLI agent: it runs its own tools instead of the subagent loop. */ cli?: CliId; /** Name of the provider a task asked for, shown in its report. */ via?: string };

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
  // Loaded on first use: the real host pulls in the workspace store, which tests that never run a CLI task do not need.
  const worktreeHost: SubagentWorktrees = cfg.worktrees ?? {
    create: async (a) => (await import("../lib/subagentWorktrees")).gitSubagentWorktrees.create(a),
    inspect: async (r, t) => (await import("../lib/subagentWorktrees")).gitSubagentWorktrees.inspect(r, t),
    remove: async (r, t) => (await import("../lib/subagentWorktrees")).gitSubagentWorktrees.remove(r, t),
  };

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

  /**
   * Where a task that names a `provider` or a `role` runs: its provider and the fallbacks, each resolved to something that
   * can run now. Null when the task names neither (the model routing above applies). Throws for anything not allowed or
   * not runnable, so a plan is refused as a whole before any task starts.
   */
  async function chooseProviders(args: SpawnArgs, settings: AgentSettings, parent: RunOptions): Promise<Runner[] | null> {
    const named = !!(args.provider || args.role);
    if (!named) {
      if (args.fallbackProviders?.length) throw new Error("`fallbackProviders` needs a `provider` or a `role`.");
      return null;
    }
    const dir = cfg.providers;
    if (!dir) throw new Error("Choosing a provider or role is not available here.");
    const known = dir.list();
    const choice = selectProviderRoute(args, settings, parent.providerId, known);
    if (!choice) return null;
    if (!choice.ok) throw new Error(choice.error);
    const fallbacks = selectFallbacks(args.fallbackProviders ?? [], settings, parent.providerId, known);
    if (!fallbacks.ok) throw new Error(fallbacks.error);
    const chain: Runner[] = [];
    for (const route of [choice.route, ...fallbacks.routes]) {
      const r = await dir.resolve(route.providerId, route.model).catch((e): { ok: false; reason: string } => ({ ok: false, reason: String((e as Error)?.message ?? e) }));
      if (!r.ok) throw new Error(`Provider "${route.providerId}" cannot run this subagent: ${r.reason}`);
      chain.push(
        r.kind === "cli"
          ? { adapter: r.adapter, providerId: route.providerId, model: r.model, cli: r.cli, via: r.name }
          : { adapter: r.adapter, providerId: route.providerId, model: r.model, supportsTools: r.supportsTools, via: r.name },
      );
    }
    return chain;
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
    if (args.fallbackProviders?.length) throw new Error("spawn_agent does not support `fallbackProviders`; use delegate_tasks with `retries`.");
    const chain = await chooseProviders(args, settings, parent);
    if (chain) return (await runTask(args, parentRef(parent), settings, parent, { runner: chain[0] })).report;
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
    const refs = new Map<string, ModelRef>();
    const chains = new Map<string, Runner[]>();
    for (const t of plan.tasks) {
      const chain = await chooseProviders(t, settings, parent).catch((e) => {
        throw new Error(`Task "${t.id}": ${String((e as Error)?.message ?? e)}`);
      });
      if (chain) chains.set(t.id, chain);
      else refs.set(t.id, chooseModel(t, settings, parent));
    }
    const outcomes = await runPlan(plan, {
      limit: scheduler.concurrency,
      signal: parent.signal,
      run: (task, deps) => {
        // Why each earlier attempt of this task failed: quota, rate limit and sign-in failures move the next attempt to the next fallback provider.
        const failures: (CliFailureKind | undefined)[] = [];
        const chain = chains.get(task.id);
        // A retry is a fresh run (new private copy or worktree for a writing task); the failed attempt's own changes are discarded.
        return runWithRetries(
          async (n, last) => {
            const runner = chain?.[chainIndex(failures, chain.length)];
            const r = await runTask({ ...task, title: n > 1 ? clip(`${task.title} (retry ${n - 1})`, MAX_TITLE) : task.title, prompt: task.prompt + dependencyContext(deps) }, refs.get(task.id) ?? parentRef(parent), settings, parent, { discardIfFailed: !last, ...(runner ? { runner } : {}) });
            failures.push(r.failure);
            return { status: r.status === "interrupted" || r.status === "queued" || r.status === "running" ? "failed" : r.status, report: r.report } satisfies Outcome;
          },
          { retries: plan.retries ?? 0, signal: parent.signal, ...(cfg.retryBackoffMs ? { backoffMs: cfg.retryBackoffMs } : {}) },
        );
      },
    });
    return mergeReports(plan, outcomes);
  }

  async function runTask(args: SpawnArgs, ref: ModelRef, settings: AgentSettings, parent: RunOptions, opts: { discardIfFailed?: boolean; /** A runner chosen by provider or role; else `ref` is resolved. */ runner?: Runner } = {}): Promise<Result> {
    const { title, prompt, type, files } = args;
    const writing = !isReadOnlyType(type);
    const budget = resolveBudget(type, cfg.budgets ?? settings.budgets);
    const runner = opts.runner ?? (await runnerFor(ref, parent));
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
      // Stopped (or the parent stopped) while the budget was checked: never prepare a copy or worktree, never start the CLI.
      if (ctl.signal.aborted) {
        finish("cancelled");
        return { status: "cancelled", report: buildReport({ title, type, status: "cancelled", text: "Cancelled before it started." }) };
      }
      updateRun(id, { status: "running", startedAt });
      if (runner.cli) return executeCli(startedAt);
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
      // The loop ran out of steps while work was still pending: a tool result, or a verification gate's feedback (a user message).
      if (!stopReason && !ctl.signal.aborted && !failure && lastRole !== "assistant" && use.steps >= budget.maxSteps) stopReason = "steps";
      const status: RunStatus = stopReason === "budget" ? "budget" : stopReason ? "limit" : failure ? "failed" : ctl.signal.aborted ? "cancelled" : "completed";
      const reason = stopReason === "budget" ? budgetStopMessage(overScope ?? "day") : stopReason ? breachMessage(stopReason, budget) : failure;
      const discard = !!opts.discardIfFailed && status === "failed";

      // Changed files (writing agents): the private copy stays as a separate pending review when it has changes.
      const { changed, warnings } = await collectChanges(reviewId, discard);

      if (runner.note) warnings.push(runner.note);
      if (gateNote) warnings.push(gateNote.slice(0, 600));
      if (stopReason) recordStep(id, { at: now(), kind: "note", text: stopReason === "budget" ? `Stopped: ${reason}.` : `Stopped at its ${reason}.`, error: true });
      const report = buildReport({ title, type, status, text: lastText, reason, changed, warnings, ...(runner.via ? { via: runner.via } : {}) });
      finish(status, { summary: clip(lastText, MAX_SUMMARY), report: lastText, ...(failure ? { error: clip(failure, 1000) } : stopReason ? { error: stopReason === "budget" ? `Stopped: ${reason}` : `Stopped at its ${reason}` } : {}), ...(changed.length ? { changed } : {}), ...(warnings.length ? { warnings } : {}) });
      return { status, report };
    }

    /** Files changed in a private shadow copy, which stays as a separate pending review when it has changes (or, for a failed attempt that will be retried, is emptied). */
    async function collectChanges(reviewId: string | undefined, discard: boolean): Promise<{ changed: string[]; warnings: string[] }> {
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
      return { changed, warnings };
    }

    /**
     * A CLI agent (Codex, Claude Code, Cursor Agent) as the subagent: its adapter runs the task prompt non-interactively in
     * an isolated directory (read-only types: the parent's folder under the CLI's own read-only sandbox; `general`: its own git
     * worktree on a `gustaf/` branch, else a private shadow copy) and its stream becomes the transcript. No Computer Use, no
     * app tools, no approvals the CLI could wait for. A breach of the run's limits kills the CLI's process tree.
     */
    async function executeCli(startedAt: number): Promise<Result> {
      let cwd = parent.root;
      let ws: SubagentWorkspace | undefined;
      let reviewId: string | undefined;
      const note = (text: string, error = false) => recordStep(id, { at: now(), kind: "note", text, ...(error ? { error: true } : {}) });
      if (writing) {
        const setup = { access: parent.access, allowlist: parent.allowlist, approve: (command: string) => parent.approve({ kind: "command", command, agent: title }).then(Boolean) };
        try {
          const made = await worktreeHost.create({ projectRoot: cfg.projectRoot, title, providerId: runner.providerId, model: runner.model, setup });
          if (made) {
            ws = made;
            cwd = made.cwd;
            note(`Working in its own git worktree on branch ${made.branch}.`);
          } else {
            const copy = await prepare(cfg.projectRoot, setup);
            reviewId = copy.review.id;
            reviewOwners.set(reviewId, id);
            cwd = copy.review.workspace;
            note("The project is not a git repository: working in a private copy.");
            if (copy.setup === "declined") note("Setup command was not run (declined or blocked).");
            else if (copy.setup && !copy.setup.ok) note("Setup command failed; the copy may lack dependencies.", true);
          }
        } catch (e) {
          const message = String((e as Error)?.message ?? e);
          finish("failed", { error: clip(message, 1000) });
          return { status: "failed", report: buildReport({ title, type, status: "failed", text: "", reason: `could not prepare an isolated directory: ${message}`, via: runner.via }) };
        }
      }

      const use = { steps: 0, toolCalls: 0, tokens: 0, startedAt };
      const collector = createCliCollector();
      const open = new Map<string, Extract<Part, { type: "activity" }>>();
      const recorded = new Set<string>();
      let stopReason = null as BudgetBreach | null;
      let overScope = null as BudgetScope | null;
      let failure = "";
      let usage: TokenUsage | undefined;
      let lastCheck = 0;
      const stopFor = (why: BudgetBreach) => {
        if (stopReason) return;
        stopReason = why;
        ctl.abort();
      };
      const say = (text: string) => {
        recordMessage(id, "assistant", [{ type: "text", text }], now());
        recordStep(id, { at: now(), kind: "text", text });
      };
      /** A call that finished (or was cut off): its tool step and the stored call and result. */
      const settle = (a: Extract<Part, { type: "activity" }>) => {
        const key = a.id || `${a.name}:${JSON.stringify(a.args ?? {})}`;
        if (recorded.has(key)) return;
        recorded.add(key);
        open.delete(key);
        recordMessage(id, "assistant", [{ type: "tool_call", id: key, name: a.name || "tool", args: a.args ?? {} }], now());
        recordMessage(id, "tool", [{ type: "tool_result", id: key, name: a.name || "tool", output: a.output ?? "", ...(a.status === "error" ? { isError: true } : {}) }], now());
        recordStep(id, activityStep(a, now()), {}, "");
      };
      // Stopped while its directory was prepared: the CLI is never started and an untouched worktree is not left behind.
      const launched = !ctl.signal.aborted;
      const timer = setTimeout(() => stopFor("time"), budget.maxMs);
      try {
        if (!launched) throw new DOMException("Aborted", "AbortError");
        const out = await runner.adapter.turn({
          system: cliSubagentSystem(type, files),
          messages: [{ role: "user", parts: [{ type: "text", text: prompt }] }],
          tools: [],
          model: runner.model,
          cwd: cwd ?? undefined,
          access: cliAccess(type, parent.access),
          killTree: true,
          signal: ctl.signal,
          onText: (d) => collector.text(d),
          onActivity: (a) => {
            if (collector.activity(a)) {
              for (const text of collector.flush()) say(text);
              use.toolCalls = collector.toolCalls();
              recordStep(id, null, { toolUses: 1 }, activityLabel(a));
              const breach = budgetBreach(use, budget, now());
              if (breach) stopFor(breach);
              else if (!stopReason && now() - lastCheck >= 5_000) {
                // The user's own token budget, at most every few seconds (the CLI reports no steps to check on).
                lastCheck = now();
                void overBudget(settings, parent).then((scope) => {
                  if (scope && !stopReason) {
                    overScope = scope;
                    stopFor("budget");
                  }
                });
              }
            }
            if (a.status === "running") open.set(a.id || `${a.name}:${JSON.stringify(a.args ?? {})}`, a);
            else settle(a);
          },
        });
        usage = out.usage;
      } catch (e) {
        if (!(ctl.signal.aborted || isAbortError(e))) failure = String((e as Error)?.message ?? e);
      } finally {
        clearTimeout(timer);
      }
      for (const a of open.values()) settle(a);
      for (const text of collector.flush(true)) say(text);
      // Tokens are known only when the CLI reports them, at the end of its run.
      use.tokens = runTokens(usage);
      if (use.tokens) {
        recordStep(id, null, { tokens: use.tokens });
        recordAgentTokens(parent.chatId, use.tokens);
        cfg.recordTokens(runner.providerId, runner.model, usage);
      }
      if (!stopReason && !ctl.signal.aborted && !failure && use.tokens > budget.maxTokens) stopReason = "tokens";
      const status: RunStatus = stopReason === "budget" ? "budget" : stopReason ? "limit" : failure ? "failed" : ctl.signal.aborted ? "cancelled" : "completed";
      const classified = failure ? classifyCliFailure(failure, now()) : undefined;
      const reason = stopReason === "budget" ? budgetStopMessage(overScope ?? "day") : stopReason ? breachMessage(stopReason, budget) : classified ? (classified.kind === "other" ? clip(failure.trim(), 600) : classified.reason) : "";
      if (classified && movesToFallback(classified.kind)) {
        try {
          await cfg.onCliFailure?.({ providerId: runner.providerId, failure: classified, message: failure });
        } catch {
          /* a failing hook never changes the run's outcome */
        }
      }
      const discard = !!opts.discardIfFailed && status === "failed";
      const warnings: string[] = [];
      let changed: string[] = [];
      let branch: { name: string; path?: string; removed?: boolean } | undefined;
      if (ws) {
        const seen = await worktreeHost.inspect(cfg.projectRoot, ws.taskId).catch(() => null);
        changed = seen?.files ?? [];
        let removed = false;
        // An untouched worktree goes only when the user asked for that, when this failed attempt is replaced by a retry, or when the CLI never started; anything else stays.
        if (seen && !seen.touched && (settings.cleanupUntouchedWorktrees || discard || !launched)) removed = await worktreeHost.remove(cfg.projectRoot, ws.taskId).catch(() => false);
        if (!seen) warnings.push(`Could not read the changes of worktree ${ws.path}; it was left in place on branch ${ws.branch}.`);
        else if (!removed) warnings.push(`Worktree left in place on branch ${ws.branch} (${ws.path}); nothing was committed, merged or pushed.`);
        branch = { name: ws.branch, path: ws.path, ...(removed ? { removed: true } : {}) };
      } else if (reviewId) {
        const r = await collectChanges(reviewId, discard);
        changed = r.changed;
        warnings.push(...r.warnings);
      }
      if (stopReason) note(stopReason === "budget" ? `Stopped: ${reason}.` : `Stopped at its ${reason}.`, true);
      else if (failure) note(`Failed: ${reason}`, true);
      const text = collector.final();
      const report = buildReport({ title, type, status, text, reason, changed, warnings, ...(branch ? { branch } : {}), ...(runner.via ? { via: runner.via } : {}) });
      finish(status, { summary: clip(text, MAX_SUMMARY), report: text, ...(failure ? { error: clip(reason, 1000) } : stopReason ? { error: stopReason === "budget" ? `Stopped: ${reason}` : `Stopped at its ${reason}` } : {}), ...(changed.length ? { changed } : {}), ...(warnings.length ? { warnings } : {}) });
      return { status, report, ...(classified ? { failure: classified.kind } : {}) };
    }
  }

  const NAMES = new Set([SPAWN_TOOL_NAME, DELEGATE_TOOL_NAME]);
  return {
    async tools(parent) {
      const settings = await settingsNow();
      const allowed = allowedRefs(settings, parent).map(refKey);
      // Providers and roles are named only when the host can route to them and the user allowed them.
      const known = cfg.providers?.list() ?? [];
      const ids = allowedProviderIds(settings, parent.providerId).filter((i) => i !== parent.providerId);
      const providers = ids.flatMap((i) => known.filter((p) => p.id === i)).map((p) => `${p.id} (${p.name}${p.cli ? ", CLI agent" : ""})`);
      const roles = (Object.entries(settings.roles) as [string, ModelRef][]).filter(([, r]) => allowedProviderIds(settings, parent.providerId).includes(r.providerId) && known.some((p) => p.id === r.providerId)).map(([name]) => name);
      const hints = { providers, roles };
      return [spawnToolFor(allowed, hints), delegateToolFor(allowed, hints)];
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
