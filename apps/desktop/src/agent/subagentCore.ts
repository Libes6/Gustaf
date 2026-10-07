// Pure logic of subagents (no app imports; tests/subagentCore.test.mjs): the `spawn_agent` tool definition and argument
// validation, per-type tool allowlists, run budgets, overlap detection between agents' changed files, report building and
// truncation, and serialization of approval requests.
import type { ToolDef } from "../providers/types";

export const AGENT_TYPES = ["explore", "plan", "general", "review"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];
export const isAgentType = (v: unknown): v is AgentType => AGENT_TYPES.includes(v as AgentType);

/** Role presets of Settings > Usage > Agents > Roles: a role names a default provider and model (agentSettings.ts). */
export const AGENT_ROLES = ["planner", "implementer", "reviewer", "tester"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const isAgentRole = (v: unknown): v is AgentRole => AGENT_ROLES.includes(v as AgentRole);

export const SPAWN_TOOL_NAME = "spawn_agent";

export const SPAWN_TOOL: ToolDef = {
  name: SPAWN_TOOL_NAME,
  description:
    "Start a subagent: a separate agent run with its own history that works on one self-contained task and returns only a final report. " +
    "Use it to explore or review in parallel, or to hand off an independent piece of work. Several spawn_agent calls in one turn run in parallel (at most 3 at a time, the rest wait). " +
    "Types: explore (read-only search and reading), plan (read-only, returns a plan), review (read-only code review), general (can edit files in its own private copy; its changes appear as a separate pending review). " +
    "The subagent cannot see this conversation: put everything it needs in `prompt`.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short name shown in the background tasks panel" },
      prompt: { type: "string", description: "Complete, self-contained instructions for the subagent" },
      type: { type: "string", enum: [...AGENT_TYPES], description: "explore | plan | general | review" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Optional project-relative files the subagent should focus on",
      },
      model: {
        type: "string",
        description: "Optional model (`provider/model`) from the allowed list; omit to use the default for the type",
      },
      provider: {
        type: "string",
        description:
          "Optional provider id from the allowed providers list (an API provider, or a CLI agent such as Codex, Claude Code or Cursor Agent that runs its own tools in its own git worktree); omit to use the default",
      },
      role: {
        type: "string",
        enum: [...AGENT_ROLES],
        description:
          "Optional role preset (planner | implementer | reviewer | tester) that chooses provider and model; cannot be combined with `provider` or `model`",
      },
      continue_from: {
        type: "string",
        description:
          "Optional id of a finished, failed or limit-stopped subagent run to continue (the run id is given in the user's message). The new run starts with a summary of that run and `prompt` as the follow-up; use the same `type` unless told otherwise",
      },
    },
    required: ["title", "prompt", "type"],
  },
};

/** What the model may name besides models: allowed provider ids (with a label) and the roles that have a preset. */
export type RoutingHints = { providers?: readonly string[]; roles?: readonly string[] };
/** The sentences naming `providers` and `roles` in a tool description (empty when there is nothing to name). */
export const routingNote = (h?: RoutingHints) =>
  [
    h?.providers?.length
      ? ` Providers you may pass in \`provider\`: ${h.providers.join(", ")}. A CLI provider runs in its own git worktree on a \`gustaf/...\` branch that is left in place for you to merge; it never merges or pushes.`
      : "",
    h?.roles?.length ? ` Roles you may pass in \`role\`: ${h.roles.join(", ")}.` : "",
  ].join("");

/** The spawn tool as offered to the model: the allowed models (and providers and roles) are named in the description. */
export const spawnToolFor = (allowedModels: readonly string[], hints?: RoutingHints): ToolDef => {
  const note = `${allowedModels.length > 1 ? ` Models you may pass in \`model\`: ${allowedModels.join(", ")}.` : ""}${routingNote(hints)}`;
  return note ? { ...SPAWN_TOOL, description: `${SPAWN_TOOL.description}${note}` } : SPAWN_TOOL;
};

export const MAX_TITLE = 80;
export const MAX_PROMPT = 20_000;
export const MAX_FILES = 20;
export const MAX_REPORT_CHARS = 8_000;

export type SpawnArgs = {
  title: string;
  prompt: string;
  type: AgentType;
  files: string[];
  /** Explicitly requested model (checked against the allow-list later). */
  model?: string;
  /** Run id to continue (the host seeds the prompt with that run's summary). */
  continueFrom?: string;
  /** Explicitly requested provider id (or unambiguous name); checked against the allowed providers later. */
  provider?: string;
  /** Role preset name (planner, implementer, reviewer, tester); resolved by the host from the agent settings. */
  role?: AgentRole;
  /** delegate_tasks: providers to move to, in order, when an attempt fails because of quota or sign-in. */
  fallbackProviders?: string[];
};

export const MAX_FALLBACK_PROVIDERS = 3;

/** A project-relative path that cannot leave the project (no absolute path, no `..`). */
export const safeRelativePath = (p: string) =>
  !!p &&
  !p.startsWith("/") &&
  !p.startsWith("~") &&
  !/^[a-z]:[\\/]/i.test(p) &&
  !p.split(/[\\/]/).includes("..") &&
  !p.includes("\0");

export function parseSpawnArgs(raw: unknown): { ok: true; value: SpawnArgs } | { ok: false; error: string } {
  const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const title = typeof a.title === "string" ? a.title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE) : "";
  const prompt = typeof a.prompt === "string" ? a.prompt.trim() : "";
  if (!title) return { ok: false, error: "spawn_agent needs a non-empty `title`." };
  if (!prompt) return { ok: false, error: "spawn_agent needs a non-empty `prompt`." };
  if (prompt.length > MAX_PROMPT)
    return { ok: false, error: `spawn_agent \`prompt\` is too long (${prompt.length} > ${MAX_PROMPT} characters).` };
  const type = a.type === undefined ? "explore" : a.type;
  if (!isAgentType(type))
    return { ok: false, error: `spawn_agent \`type\` must be one of: ${AGENT_TYPES.join(", ")}.` };
  const files = Array.isArray(a.files)
    ? [
        ...new Set(
          a.files
            .filter((f): f is string => typeof f === "string")
            .map((f) => f.trim().replace(/^\.\//, ""))
            .filter(safeRelativePath),
        ),
      ].slice(0, MAX_FILES)
    : [];
  const model = typeof a.model === "string" && a.model.trim() ? a.model.trim().slice(0, 300) : undefined;
  const continueFrom =
    typeof a.continue_from === "string" && a.continue_from.trim() ? a.continue_from.trim().slice(0, 100) : undefined;
  const provider = typeof a.provider === "string" && a.provider.trim() ? a.provider.trim().slice(0, 100) : undefined;
  if (a.role !== undefined && a.role !== null && a.role !== "" && !isAgentRole(a.role))
    return {
      ok: false,
      error: `spawn_agent \`role\` must be one of: ${AGENT_ROLES.join(", ")} (got ${JSON.stringify(String(a.role).slice(0, 40))}).`,
    };
  const role = isAgentRole(a.role) ? a.role : undefined;
  if (role && (provider || model))
    return { ok: false, error: "spawn_agent: use either `role` or `provider`/`model`, not both." };
  let fallbackProviders: string[] | undefined;
  if (a.fallbackProviders !== undefined && a.fallbackProviders !== null) {
    if (!Array.isArray(a.fallbackProviders) || a.fallbackProviders.some((f) => typeof f !== "string" || !f.trim()))
      return { ok: false, error: "spawn_agent `fallbackProviders` must be a list of provider ids." };
    fallbackProviders = [...new Set((a.fallbackProviders as string[]).map((f) => f.trim().slice(0, 100)))];
    if (fallbackProviders.length > MAX_FALLBACK_PROVIDERS)
      return {
        ok: false,
        error: `spawn_agent \`fallbackProviders\` takes at most ${MAX_FALLBACK_PROVIDERS} providers.`,
      };
  }
  return {
    ok: true,
    value: {
      title,
      prompt,
      type,
      files,
      ...(model ? { model } : {}),
      ...(continueFrom ? { continueFrom } : {}),
      ...(provider ? { provider } : {}),
      ...(role ? { role } : {}),
      ...(fallbackProviders?.length ? { fallbackProviders } : {}),
    },
  };
}

// ---- per-type tool allowlists ----

const READ_ONLY_TOOLS = ["read_file", "list_dir", "search"];
export const TYPE_TOOLS: Record<AgentType, readonly string[] | null> = {
  explore: READ_ONLY_TOOLS,
  plan: READ_ONLY_TOOLS,
  review: READ_ONLY_TOOLS,
  general: null, // everything the parent's access mode allows, except spawn_agent itself
};
/** Types that never write: they run in the parent's workspace, without a private copy. */
export const isReadOnlyType = (t: AgentType) => TYPE_TOOLS[t] !== null;
/** Tool names a subagent of this type may use (`null` = no extra restriction beyond the access mode). Never includes spawn_agent. */
export const allowedToolNames = (t: AgentType): string[] | null => (TYPE_TOOLS[t] ? [...TYPE_TOOLS[t]!] : null);
export function filterTools(t: AgentType, tools: ToolDef[]): ToolDef[] {
  const allowed = TYPE_TOOLS[t];
  return tools.filter((d) => d.name !== SPAWN_TOOL_NAME && (!allowed || allowed.includes(d.name)));
}

// ---- budgets ----

export type Budget = { maxSteps: number; maxToolCalls: number; maxMs: number; maxTokens: number };
export type BudgetOverrides = Partial<Record<AgentType, Partial<Budget>>>;
export const DEFAULT_BUDGETS: Record<AgentType, Budget> = {
  explore: { maxSteps: 20, maxToolCalls: 40, maxMs: 5 * 60_000, maxTokens: 600_000 },
  plan: { maxSteps: 15, maxToolCalls: 30, maxMs: 5 * 60_000, maxTokens: 500_000 },
  review: { maxSteps: 20, maxToolCalls: 40, maxMs: 5 * 60_000, maxTokens: 600_000 },
  general: { maxSteps: 40, maxToolCalls: 80, maxMs: 15 * 60_000, maxTokens: 1_500_000 },
};
export const HARD_CAPS: Budget = { maxSteps: 100, maxToolCalls: 300, maxMs: 60 * 60_000, maxTokens: 5_000_000 };

/** The budget of one run: defaults for the type, overridden by (validated) overrides, never above the hard caps. */
export function resolveBudget(type: AgentType, overrides?: BudgetOverrides): Budget {
  const base = { ...DEFAULT_BUDGETS[type] };
  const o = overrides?.[type] ?? {};
  for (const k of Object.keys(base) as (keyof Budget)[]) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 1) base[k] = Math.min(HARD_CAPS[k], Math.floor(v));
  }
  return base;
}

export type BudgetUse = { steps: number; toolCalls: number; tokens: number; startedAt: number };
/** `budget`: the user's day or chat token budget (not one of the run's own limits; see `budgetStopMessage`). */
export type BudgetBreach = "steps" | "toolCalls" | "tokens" | "time" | "budget";

/** Which limit has been exceeded, if any. Steps count model turns; a run may use exactly its limit. */
export function budgetBreach(use: BudgetUse, b: Budget, now: number): BudgetBreach | null {
  if (use.toolCalls > b.maxToolCalls) return "toolCalls";
  if (use.tokens > b.maxTokens) return "tokens";
  if (now - use.startedAt > b.maxMs) return "time";
  if (use.steps > b.maxSteps) return "steps";
  return null;
}
export const breachMessage = (x: Exclude<BudgetBreach, "budget">, b: Budget) =>
  ({
    steps: `step limit (${b.maxSteps})`,
    toolCalls: `tool call limit (${b.maxToolCalls})`,
    tokens: `token limit (${b.maxTokens})`,
    time: `time limit (${Math.round(b.maxMs / 1000)} s)`,
  })[x];

/** Which of the user's token budgets (Settings > Usage > Budgets) stopped agents. */
export type BudgetScope = "day" | "chat";
/** Text for a stopped run and for the tool error of a refused spawn. */
export const budgetStopMessage = (scope: BudgetScope) =>
  `the ${scope === "day" ? "daily" : "chat"} token budget is exceeded (Settings > Usage > Budgets; turn off "stop agents when over budget" in the agent settings to continue)`;

// ---- overlap detection ----

export type FileSet = { id: string; label: string; files: readonly string[] };
export type Overlap = { id: string; label: string; files: string[] };

/** Other agents (or pending reviews) whose changed files intersect `own`. */
export function findOverlaps(own: FileSet, others: readonly FileSet[]): Overlap[] {
  const mine = new Set(own.files);
  const out: Overlap[] = [];
  for (const o of others) {
    if (o.id === own.id) continue;
    const common = [...new Set(o.files)].filter((f) => mine.has(f)).sort();
    if (common.length) out.push({ id: o.id, label: o.label, files: common });
  }
  return out;
}

export function overlapWarning(overlaps: readonly Overlap[], maxFiles = 5): string {
  if (!overlaps.length) return "";
  const parts = overlaps.map(
    (o) =>
      `"${o.label}" (${o.files.slice(0, maxFiles).join(", ")}${o.files.length > maxFiles ? `, +${o.files.length - maxFiles} more` : ""})`,
  );
  return `Warning: these changes touch files also changed by ${parts.join("; ")}. Accepting both will conflict; review them one after the other.`;
}

// ---- reports ----

export function truncateReport(text: string, max = MAX_REPORT_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const keep = Math.max(0, max - 60);
  return `${t.slice(0, keep).trimEnd()}\n[report truncated: ${t.length - keep} characters omitted]`;
}

export type ReportInput = {
  title: string;
  type: AgentType;
  status: "completed" | "failed" | "cancelled" | "limit" | "budget";
  text: string;
  /** Why it stopped early (budget breach or error message). */
  reason?: string;
  changed?: readonly string[];
  warnings?: readonly string[];
  max?: number;
  /** A CLI subagent that worked in a git worktree: its branch is left in place (nothing merged or pushed) instead of a pending review copy. */
  branch?: { name: string; path?: string; removed?: boolean };
  /** The provider that ran it, named in the report when it is not the parent's own. */
  via?: string;
};

/** The only thing the parent sees of a subagent run. Bounded in length. */
export function buildReport(r: ReportInput): string {
  const head = `Subagent "${r.title}" (${r.type}${r.via ? `, via ${r.via}` : ""}) ${r.status === "completed" ? "finished" : r.status === "limit" ? `stopped at its ${r.reason}` : r.status === "budget" ? `was stopped: ${r.reason}` : r.status === "cancelled" ? "was cancelled" : "failed"}${r.status === "failed" && r.reason ? `: ${r.reason}` : ""}.`;
  const body = r.text.trim() ? truncateReport(r.text, r.max ?? MAX_REPORT_CHARS) : "(no report text)";
  const lines = [head, "", body];
  const list = r.changed ? `${r.changed.slice(0, 30).join(", ")}${r.changed.length > 30 ? ", ..." : ""}` : "";
  if (r.branch) {
    const where = r.branch.path ? ` (worktree ${r.branch.path})` : "";
    if (r.branch.removed)
      lines.push("", `No files were changed; its worktree and branch ${r.branch.name} were removed.`);
    else if (r.changed?.length)
      lines.push(
        "",
        `Changed files (${r.changed.length}) on branch ${r.branch.name}${where}, left in place; nothing was committed, merged or pushed. Commit and merge it from the workspace or the merge queue: ${list}`,
      );
    else lines.push("", `No files were changed. Branch ${r.branch.name} was left in place${where}.`);
  } else if (r.changed?.length)
    lines.push(
      "",
      `Changed files (${r.changed.length}, pending in a separate review in the Changes panel, nothing applied yet): ${list}`,
    );
  else if (r.type === "general") lines.push("", "No files were changed.");
  for (const w of r.warnings ?? []) lines.push("", w);
  return lines.join("\n");
}

// ---- approvals ----

/** Makes concurrent calls of `fn` run one after another, so only one approval card is open at a time. A rejection does not block the queue. */
export function serializeCalls<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (...args: A) => {
    const next = tail.then(() => fn(...args));
    tail = next.catch(() => {});
    return next;
  };
}

// ---- prompts ----

const COMMON =
  "You are a subagent started by the main Gustaf agent for one task. You cannot ask the user questions and cannot see the main conversation. Your final message is your report: the main agent receives only that, so put the results in it, concisely (under 400 words), with project-relative file paths.";
const TYPE_PROMPT: Record<AgentType, string> = {
  explore:
    "You are read-only: investigate with list_dir/search/read_file and report what you found (paths and line numbers). Do not propose edits unless asked.",
  plan: "You are read-only: study the code and return a concrete, ordered implementation plan (files to change, what to change, risks). Do not make edits.",
  review:
    "You are read-only: review the code or changes named in the task for bugs, regressions and missing tests. List findings by severity with file and line. Say so if you found nothing.",
  general:
    "You may edit files and run commands, but only in your own private copy of the project; your changes will be reviewed by the user before anything is applied. Finish by listing what you changed and what you could not verify.",
};
export function subagentSystem(type: AgentType, files: readonly string[]): string {
  return [COMMON, TYPE_PROMPT[type], files.length ? `Focus on: ${files.join(", ")}.` : ""].filter(Boolean).join("\n");
}
