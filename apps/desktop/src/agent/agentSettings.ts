// Pure settings of background agents (tests/agentSettings.test.mjs): default model per agent type, the allow-list of models
// an agent call may request explicitly, per-type budget defaults, the cheap model for summaries/commit messages, the
// orchestration default and notifications. Stored in the app `settings` table under "agentSettings" (agentSettingsStore.ts).
import { AGENT_TYPES, HARD_CAPS, type AgentType, type Budget, type BudgetOverrides } from "./subagentCore";

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
};

export const DEFAULT_AGENT_SETTINGS: AgentSettings = { models: {}, allowedModels: [], budgets: {}, cheapModel: null, cancelDependents: true, stopOnBudget: true, notifications: true };

export const refKey = (r: ModelRef) => `${r.providerId}/${r.model}`;
export const sameRef = (a: ModelRef | null | undefined, b: ModelRef | null | undefined) => !!a && !!b && a.providerId === b.providerId && a.model === b.model;

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
  return {
    models,
    allowedModels,
    budgets,
    cheapModel: normalizeRef(r.cheapModel),
    cancelDependents: r.cancelDependents !== false,
    stopOnBudget: r.stopOnBudget !== false,
    notifications: r.notifications !== false,
  };
}

/** Models an agent call may name: the allow-list, the per-type defaults and the parent's own model. */
export function allowedRefs(s: AgentSettings, parent: ModelRef): ModelRef[] {
  const out: ModelRef[] = [];
  for (const r of [parent, ...Object.values(s.models), ...s.allowedModels]) if (r && !out.some((o) => sameRef(o, r))) out.push(r);
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

export type ModelChoice = { ok: true; ref: ModelRef; source: "requested" | "type" | "parent" } | { ok: false; error: string };

/**
 * The model a subagent runs on: an explicitly requested one (only from the allowed models), else the type's default,
 * else the parent's model. Whether the chosen model is actually usable is checked by the caller (it falls back to the parent).
 */
export function selectModel(type: AgentType, s: AgentSettings, parent: ModelRef, requested?: string): ModelChoice {
  if (requested !== undefined && requested.trim()) {
    const allowed = allowedRefs(s, parent);
    const ref = matchModelArg(requested, allowed);
    if (!ref) return { ok: false, error: `Model "${requested.trim()}" is not allowed for subagents. Allowed: ${allowed.map(refKey).join(", ")}. Omit \`model\` to use the default.` };
    return { ok: true, ref, source: sameRef(ref, parent) ? "parent" : "requested" };
  }
  const typed = s.models[type];
  return typed && !sameRef(typed, parent) ? { ok: true, ref: typed, source: "type" } : { ok: true, ref: parent, source: "parent" };
}

/** The model for compaction and commit messages: the configured cheap model when it is usable, else the chat's own. */
export const cheapModelFor = (s: AgentSettings, fallback: ModelRef, usable: (r: ModelRef) => boolean): ModelRef => (s.cheapModel && usable(s.cheapModel) ? s.cheapModel : fallback);
