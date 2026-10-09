// Pure settings of background agents (tests/agentSettings.test.mjs): default model per agent type, the allow-list of models
// an agent call may request explicitly, per-type budget defaults, the cheap model for summaries/commit messages, the
// orchestration default and notifications. Stored in the app `settings` table under "agentSettings" (agentSettingsStore.ts).
import {
  AGENT_ROLES,
  AGENT_TYPES,
  HARD_CAPS,
  type AgentRole,
  type AgentType,
  type Budget,
  type BudgetOverrides,
} from "./subagentCore";

export const AGENT_SETTINGS = "agentSettings";
export const MAX_ALLOWED_MODELS = 20;

export type ModelRef = { providerId: string; model: string };
export type AgentSettings = {
  /** Default model per type; a missing entry means "the parent's model". */
  models: Partial<Record<AgentType, ModelRef>>;
  /** Extra models `spawn_agent` / `delegate_tasks` may name in `model`. */
  allowedModels: ModelRef[];
  /** Per-type budget defaults (validated, under the hard caps); missing fields use DEFAULT_BUDGETS. */
  budgets: BudgetOverrides;
  /** Model for chat compaction and commit messages; null = the chat's model. */
  cheapModel: ModelRef | null;
  /** delegate_tasks: a failed task cancels the tasks that depend on it (unless the call says otherwise). */
  cancelDependents: boolean;
  /** Stop running subagents at their next step, and refuse new ones, while the day or chat token budget (Settings > Usage) is exceeded. Elsewhere budgets stay warnings. */
  stopOnBudget: boolean;
  /** Native notification / dock badge when a background agent finishes, fails or waits for approval while the app is unfocused. */
  notifications: boolean;
  /** Role presets (planner, implementer, reviewer, tester): the provider and model a task naming the role runs on. The provider must also be allowed (see `allowedProviderIds`). */
  roles: Partial<Record<AgentRole, ModelRef>>;
  /** Provider ids a task may name in `provider` (API or CLI), besides the chat's own provider and the providers of the type defaults and allowed models. */
  allowedProviders: string[];
  /** Remove the worktree and branch of a CLI subagent when it ends without any change (committed or not). Off by default: worktrees are always kept. */
  cleanupUntouchedWorktrees: boolean;
  /** CLI main agents (Claude Code, Codex, Cursor Agent) may start subagents through the `gustaf-agent` command (what they may request is limited by `allowedProviders` like for API agents). */
  cliSubagents: boolean;
};

export const MAX_ALLOWED_PROVIDERS = 20;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  models: {},
  allowedModels: [],
  budgets: {},
  cheapModel: null,
  cancelDependents: true,
  stopOnBudget: true,
  notifications: true,
  roles: {},
  allowedProviders: [],
  cleanupUntouchedWorktrees: false,
  cliSubagents: true,
};

export const refKey = (r: ModelRef) => `${r.providerId}/${r.model}`;
export const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) =>
  !!a && !!b && a.providerId === b.providerId && a.model === b.model;

export function normalizeRef(raw: unknown): ModelRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const providerId = typeof r.providerId === "string" ? r.providerId.trim().slice(0, 100) : "";
  const model = typeof r.model === "string" ? r.model.trim().slice(0, 200) : "";
  return providerId && model ? { providerId, model } : null;
}

const BUDGET_KEYS: (keyof Budget)[] = ["maxSteps", "maxToolCalls", "maxMs", "maxTokens"];
/** One budget field as typed or stored: a whole number >= 1, capped; anything else means "use the default". */
export function budgetValue(key: keyof Budget, v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(HARD_CAPS[key], Math.floor(v)) : undefined;
}

export function normalizeAgentSettings(raw: unknown): AgentSettings {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const models: AgentSettings["models"] = {};
  const budgets: BudgetOverrides = {};
  const rm = r.models && typeof r.models === "object" ? (r.models as Record<string, unknown>) : {};
  const rb = r.budgets && typeof r.budgets === "object" ? (r.budgets as Record<string, unknown>) : {};
  for (const t of AGENT_TYPES) {
    const ref = normalizeRef(rm[t]);
    if (ref) models[t] = ref;
    const b = rb[t] && typeof rb[t] === "object" ? (rb[t] as Record<string, unknown>) : {};
    const out: Partial<Budget> = {};
    for (const k of BUDGET_KEYS) {
      const v = budgetValue(k, b[k]);
      if (v !== undefined) out[k] = v;
    }
    if (Object.keys(out).length) budgets[t] = out;
  }
  const seen = new Set<string>();
  const allowedModels = (Array.isArray(r.allowedModels) ? r.allowedModels : [])
    .map(normalizeRef)
    .filter((x): x is ModelRef => !!x && !seen.has(refKey(x)) && !!seen.add(refKey(x)))
    .slice(0, MAX_ALLOWED_MODELS);
  const roles: AgentSettings["roles"] = {};
  const rr = r.roles && typeof r.roles === "object" ? (r.roles as Record<string, unknown>) : {};
  for (const role of AGENT_ROLES) {
    const ref = normalizeRef(rr[role]);
    if (ref) roles[role] = ref;
  }
  const allowedProviders = [
    ...new Set(
      (Array.isArray(r.allowedProviders) ? r.allowedProviders : [])
        .filter((x): x is string => typeof x === "string" && !!x.trim())
        .map((x) => x.trim().slice(0, 100)),
    ),
  ].slice(0, MAX_ALLOWED_PROVIDERS);
  return {
    models,
    allowedModels,
    budgets,
    cheapModel: normalizeRef(r.cheapModel),
    cancelDependents: r.cancelDependents !== false,
    stopOnBudget: r.stopOnBudget !== false,
    notifications: r.notifications !== false,
    roles,
    allowedProviders,
    cleanupUntouchedWorktrees: r.cleanupUntouchedWorktrees === true,
    cliSubagents: r.cliSubagents !== false,
  };
}

/** Models an agent call may name: the allow-list, the per-type defaults and the parent's own model. */
export function allowedRefs(s: AgentSettings, parent: ModelRef): ModelRef[] {
  const out: ModelRef[] = [];
  for (const r of [parent, ...Object.values(s.models), ...s.allowedModels])
    if (r && !out.some((o) => sameRef(o, r))) out.push(r);
  return out;
}

/** Matches a `model` argument against the allowed models: `provider/model` exactly, or a model id that is unambiguous. */
export function matchModelArg(arg: string, allowed: readonly ModelRef[]): ModelRef | null {
  const a = arg.trim();
  if (!a) return null;
  const exact = allowed.find((r) => refKey(r) === a);
  if (exact) return exact;
  const byId = allowed.filter((r) => r.model === a);
  return byId.length === 1 ? byId[0] : null;
}

export type ModelChoice =
  { ok: true; ref: ModelRef; source: "requested" | "type" | "parent" } | { ok: false; error: string };

/**
 * The model a subagent runs on: an explicitly requested one (only from the allowed models), else the type's default,
 * else the parent's model. Whether the chosen model is actually usable is checked by the caller (it falls back to the parent).
 */
export function selectModel(type: AgentType, s: AgentSettings, parent: ModelRef, requested?: string): ModelChoice {
  if (requested !== undefined && requested.trim()) {
    const allowed = allowedRefs(s, parent);
    const ref = matchModelArg(requested, allowed);
    if (!ref)
      return {
        ok: false,
        error: `Model "${requested.trim()}" is not allowed for subagents. Allowed: ${allowed.map(refKey).join(", ")}. Omit \`model\` to use the default.`,
      };
    return { ok: true, ref, source: sameRef(ref, parent) ? "parent" : "requested" };
  }
  const typed = s.models[type];
  return typed && !sameRef(typed, parent)
    ? { ok: true, ref: typed, source: "type" }
    : { ok: true, ref: parent, source: "parent" };
}

/** The model for compaction and commit messages: the configured cheap model when it is usable, else the chat's own. */
export const cheapModelFor = (s: AgentSettings, fallback: ModelRef, usable: (r: ModelRef) => boolean): ModelRef =>
  s.cheapModel && usable(s.cheapModel) ? s.cheapModel : fallback;

// ---- providers and roles ----

/** A provider a task may be routed to, as the host's provider directory lists it (enabled providers only). */
export type ProviderLite = {
  id: string;
  name: string;
  /** A CLI agent that runs its own tools. */ cli?: boolean;
  /** Models a task may name (API providers: those with tool support). Absent: not known. */
  models?: { id: string; name: string }[];
  /** Why no task can run on it (for example Antigravity cannot run non-interactively). Absent: usable. */
  unusable?: string;
};

/** Provider ids a task may name: the chat's own, those of the type defaults and of the allowed models, and the allow-list. Roles are NOT included: a role's provider has to be allowed on its own. */
export function allowedProviderIds(s: AgentSettings, parentProviderId: string): string[] {
  return [
    ...new Set([
      parentProviderId,
      ...Object.values(s.models).map((r) => r.providerId),
      ...s.allowedModels.map((r) => r.providerId),
      ...s.allowedProviders,
    ]),
  ];
}

/** Matches a `provider` argument: an exact id, else a name (case-insensitive) that only one provider has. */
export function matchProviderArg(arg: string, known: readonly ProviderLite[]): ProviderLite | null {
  const a = arg.trim();
  if (!a) return null;
  const byId = known.find((p) => p.id === a);
  if (byId) return byId;
  const byName = known.filter((p) => p.name.trim().toLowerCase() === a.toLowerCase());
  return byName.length === 1 ? byName[0] : null;
}

export type ProviderRoute = {
  providerId: string;
  /** Absent: the provider's default model. */ model?: string;
  via: "role" | "provider";
  role?: AgentRole;
};
export type RouteChoice = { ok: true; route: ProviderRoute } | { ok: false; error: string };

const listProviders = (ids: readonly string[], known: readonly ProviderLite[]) =>
  ids
    .map((id) => known.find((p) => p.id === id))
    .filter((p): p is ProviderLite => !!p)
    .map((p) => `${p.id} (${p.name})`)
    .join(", ") || "none";

/** One provider id (or name) checked against the known providers and the allowed ones. */
function allowedProvider(
  arg: string,
  s: AgentSettings,
  parentProviderId: string,
  known: readonly ProviderLite[],
  what: string,
): { ok: true; id: string } | { ok: false; error: string } {
  const p = matchProviderArg(arg, known);
  const allowed = allowedProviderIds(s, parentProviderId);
  if (!p)
    return {
      ok: false,
      error: `${what} "${arg.trim()}" is not a known, enabled provider. Allowed: ${listProviders(allowed, known)}.`,
    };
  if (!allowed.includes(p.id))
    return {
      ok: false,
      error: `${what} "${p.id}" is not allowed for subagents (Settings > Usage > Agents > Allowed providers). Allowed: ${listProviders(allowed, known)}.`,
    };
  return { ok: true, id: p.id };
}

/**
 * Where a task runs when it names a provider or a role; null when it names neither (the existing model routing applies).
 * A role resolves to its preset, which must name an enabled and allowed provider. An explicit provider must be allowed.
 */
export function selectProviderRoute(
  a: { provider?: string; role?: AgentRole; model?: string },
  s: AgentSettings,
  parentProviderId: string,
  known: readonly ProviderLite[],
): RouteChoice | null {
  if (a.role) {
    const preset = s.roles[a.role];
    if (!preset)
      return { ok: false, error: `Role "${a.role}" has no provider configured (Settings > Usage > Agents > Roles).` };
    const p = allowedProvider(preset.providerId, s, parentProviderId, known, `Provider of role "${a.role}"`);
    return p.ok ? { ok: true, route: { providerId: p.id, model: preset.model, via: "role", role: a.role } } : p;
  }
  if (!a.provider) return null;
  const p = allowedProvider(a.provider, s, parentProviderId, known, "Provider");
  return p.ok
    ? { ok: true, route: { providerId: p.id, ...(a.model?.trim() ? { model: a.model.trim() } : {}), via: "provider" } }
    : p;
}

/** The fallback providers of a task, each checked like an explicit provider. */
export function selectFallbacks(
  ids: readonly string[],
  s: AgentSettings,
  parentProviderId: string,
  known: readonly ProviderLite[],
): { ok: true; routes: ProviderRoute[] } | { ok: false; error: string } {
  const routes: ProviderRoute[] = [];
  for (const id of ids) {
    const p = allowedProvider(id, s, parentProviderId, known, "Fallback provider");
    if (!p.ok) return p;
    routes.push({ providerId: p.id, via: "provider" });
  }
  return { ok: true, routes };
}
