// Pure description of where a subagent may run, for CLI agents that cannot see the `spawn_agent` tool definition
// (tests/agentBridge.test.mjs): the providers and models a task may request with their state, the roles, and the
// resolution of a name such as "Composer 2" to a provider and model id. Only `import type` from app modules.
import {
  allowedProviderIds,
  matchProviderArg,
  refKey,
  type AgentSettings,
  type ModelRef,
  type ProviderLite,
} from "./agentSettings";
import { AGENT_ROLES, AGENT_TYPES, DEFAULT_BUDGETS, type AgentRole } from "./subagentCore";

export type TargetModel = { id: string; name: string };
export type TargetProvider = {
  id: string;
  name: string;
  kind: "api" | "cli";
  /** Named in Settings > Usage > Agents (or the chat's own provider): a task may request it. */
  allowed: boolean;
  /** Allowed and able to run a task now. */
  usable: boolean;
  /** Why it cannot be requested (not allowed, or not able to run subagents). */
  reason?: string;
  models: TargetModel[];
};
export type TargetRole = { role: AgentRole; providerId: string; model: string; usable: boolean };
export type AgentTargets = {
  /** The chat's own provider and model, `provider/model`. */
  parent: string;
  parentProviderId: string;
  providers: TargetProvider[];
  roles: TargetRole[];
  /** Subagents that run at the same time (the rest wait). */
  concurrency: number;
  stopOnBudget: boolean;
};

/** Providers, models and roles from the settings and the host's provider list. */
export function buildTargets(
  settings: AgentSettings,
  parent: ModelRef,
  known: readonly ProviderLite[],
  concurrency: number,
): AgentTargets {
  const allowed = new Set(allowedProviderIds(settings, parent.providerId));
  const providers = known.map((p): TargetProvider => {
    const isAllowed = allowed.has(p.id);
    const reason = !isAllowed
      ? "not allowed: add it under Settings > Usage > Agents > Providers agents may request"
      : p.unusable;
    return {
      id: p.id,
      name: p.name,
      kind: p.cli ? "cli" : "api",
      allowed: isAllowed,
      usable: isAllowed && !p.unusable,
      ...(reason ? { reason } : {}),
      models: p.models ?? [],
    };
  });
  const roles = AGENT_ROLES.flatMap((role): TargetRole[] => {
    const ref = settings.roles[role];
    if (!ref) return [];
    return [
      {
        role,
        providerId: ref.providerId,
        model: ref.model,
        usable: providers.some((p) => p.id === ref.providerId && p.usable),
      },
    ];
  });
  return {
    parent: refKey(parent),
    parentProviderId: parent.providerId,
    providers,
    roles,
    concurrency,
    stopOnBudget: settings.stopOnBudget,
  };
}

const MODELS_SHOWN = 30;
const norm = (s: string) => s.trim().toLowerCase();
const matches = (p: TargetProvider, m: TargetModel | null, filter: string) =>
  [p.id, p.name, m?.id ?? "", m?.name ?? ""].some((x) => norm(x).includes(filter));

/** The `list` output. `filter`: only providers and models whose id or name contains it (case-insensitive). */
export function renderTargets(t: AgentTargets, filter = ""): string {
  const f = norm(filter);
  const lines: string[] = [
    `Subagents you may start with \`spawn\` / \`delegate\` (this chat runs on ${t.parent}).`,
    'Pass --provider <id or name> and --model <id or name>; a model name alone (for example --model "Composer 2") also works when it is unambiguous.',
    "",
  ];
  let shown = 0;
  for (const p of t.providers) {
    const models = f && !matches(p, null, f) ? p.models.filter((m) => matches(p, m, f)) : p.models;
    if (f && !models.length && !matches(p, null, f)) continue;
    shown++;
    const state = p.usable ? "usable" : (p.reason ?? "not usable");
    lines.push(`${p.id}  "${p.name}"  [${p.kind === "cli" ? "CLI agent" : "API"}; ${state}]`);
    if (!p.models.length)
      lines.push(p.kind === "cli" ? "    models: its own default (omit --model)" : "    models: none known");
    for (const m of models.slice(0, MODELS_SHOWN)) lines.push(`    ${m.id}  "${m.name}" (${p.name})`);
    if (models.length > MODELS_SHOWN)
      lines.push(`    ... ${models.length - MODELS_SHOWN} more: narrow the list with \`list <text>\``);
  }
  if (!shown) lines.push(f ? `Nothing matches "${filter.slice(0, 60)}".` : "No provider is enabled.");
  if (t.roles.length) {
    lines.push("", "Roles (--role <name> picks a provider and model; do not combine with --provider/--model):");
    for (const r of t.roles)
      lines.push(`    ${r.role} -> ${r.providerId}/${r.model}${r.usable ? "" : " (not usable now)"}`);
  }
  lines.push(
    "",
    `Types (--type): ${AGENT_TYPES.join(", ")}. explore, plan and review are read-only (they may be unable to run commands); general may edit files and run commands, in its own git worktree on a gustaf/ branch for CLI providers.`,
    `At most ${t.concurrency} subagents run at the same time, the rest wait. Default limits for general tasks: ${Math.round(DEFAULT_BUDGETS.general.maxMs / 60_000)} min, ${DEFAULT_BUDGETS.general.maxToolCalls} tool calls; read-only types ${Math.round(DEFAULT_BUDGETS.explore.maxMs / 60_000)} min.${t.stopOnBudget ? " Tasks are refused or stopped while the user's token budget is exceeded." : ""}`,
  );
  return lines.join("\n");
}

export type TargetArgs = { provider?: string; model?: string; role?: string };
export type TargetChoice = { ok: true; provider?: string; model?: string } | { ok: false; error: string };

/**
 * Turns what the agent typed into ids the host accepts: a model name becomes its id, and `--model` without `--provider`
 * finds the one provider that has such a model. Anything not listed passes through unchanged for the host to refuse with
 * its own message, except an ambiguous or unknown model without a provider, which is refused here with the candidates.
 */
export function resolveTarget(a: TargetArgs, t: AgentTargets): TargetChoice {
  if (a.role) return { ok: true };
  let provider = a.provider?.trim() || undefined;
  let model = a.model?.trim() || undefined;
  if (!provider && model?.includes("/")) {
    const slash = model.indexOf("/");
    const byId = t.providers.find((p) => p.id === model!.slice(0, slash));
    if (byId) [provider, model] = [byId.id, model.slice(slash + 1)];
  }
  const modelIn = (p: TargetProvider, wanted: string) => {
    const w = norm(wanted);
    return (
      p.models.find((m) => m.id === wanted) ??
      p.models.find((m) => norm(m.id) === w) ??
      p.models.find((m) => norm(m.name) === w)
    );
  };
  if (provider) {
    const p = matchProviderArg(provider, t.providers);
    const full = p ? t.providers.find((x) => x.id === p.id) : undefined;
    if (!full || !model) return { ok: true, provider, ...(model ? { model } : {}) };
    return { ok: true, provider: full.id, model: modelIn(full, model)?.id ?? model };
  }
  if (!model) return { ok: true };
  const pool = t.providers.filter((p) => p.usable);
  let hits = pool.flatMap((p) => {
    const m = modelIn(p, model!);
    return m ? [{ p, m }] : [];
  });
  if (!hits.length) {
    const w = norm(model);
    hits = pool.flatMap((p) =>
      p.models.filter((m) => norm(m.name).includes(w) || norm(m.id).includes(w)).map((m) => ({ p, m })),
    );
  }
  if (hits.length === 1) return { ok: true, provider: hits[0].p.id, model: hits[0].m.id };
  const names = hits
    .slice(0, 8)
    .map(({ p, m }) => `${p.id}/${m.id} ("${m.name}")`)
    .join(", ");
  return {
    ok: false,
    error: hits.length
      ? `Model "${model.slice(0, 60)}" matches several: ${names}. Pass --provider and the exact --model id.`
      : `No usable provider has a model "${model.slice(0, 60)}". Run \`gustaf-agent list ${model.slice(0, 30)}\` to search; a provider that is not allowed shows why.`,
  };
}
