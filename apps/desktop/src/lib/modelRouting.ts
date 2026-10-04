// Model routing glue between the agent settings and the configured providers: which models subagents can run on and
// which model compaction / commit messages use. The choice logic itself is pure (agent/agentSettings.ts).
import { cheapModelFor, type AgentSettings, type ModelRef } from "../agent/agentSettings";
import type { ResolvedModel } from "../agent/subagents";
import { getAdapter } from "../providers";
import type { ModelInfo, ProviderConfig } from "../providers/types";

type Catalog = { providers: ProviderConfig[]; models: ModelInfo[] };

const findModel = (c: Catalog, ref: ModelRef) => c.models.find((m) => m.providerId === ref.providerId && m.id === ref.model);
const findProvider = (c: Catalog, ref: ModelRef) => c.providers.find((p) => p.id === ref.providerId && !p.disabled);

/** CLI agents run their own tools (and approvals) in the folder, so they cannot host a subagent loop. */
export const runsOwnTools = (p: ProviderConfig) => p.kind === "cli" || p.kind === "cursor";

/** A listed model of an enabled provider. */
export const isUsable = (c: Catalog, ref: ModelRef) => !!findProvider(c, ref) && !!findModel(c, ref);

/** Resolves a model for a subagent: an API provider's listed model with tool support, else null. */
export function subagentModelResolver(c: Catalog): (ref: ModelRef) => Promise<ResolvedModel> {
  return async (ref) => {
    const provider = findProvider(c, ref);
    const info = findModel(c, ref);
    if (!provider || !info || runsOwnTools(provider) || info.tools === false) return null;
    return { adapter: await getAdapter(provider), supportsTools: info.tools };
  };
}

/** Provider and model for compaction / commit messages: the cheap model when configured and usable, else the given one. */
export function cheapTarget(s: AgentSettings, c: Catalog, fallback: { provider: ProviderConfig; model: string }): { provider: ProviderConfig; model: string; info?: ModelInfo } {
  const ref = cheapModelFor(s, { providerId: fallback.provider.id, model: fallback.model }, (r) => isUsable(c, r));
  const provider = findProvider(c, ref) ?? fallback.provider;
  const model = provider === fallback.provider && ref.providerId !== fallback.provider.id ? fallback.model : ref.model;
  return { provider, model, info: findModel(c, { providerId: provider.id, model }) };
}

/**
 * Provider and model for the AI review of changes: the model configured for the `review` agent type when it is usable
 * (Settings > Agents), else the cheap model, else the given one.
 */
export function reviewTarget(s: AgentSettings, c: Catalog, fallback: { provider: ProviderConfig; model: string }): { provider: ProviderConfig; model: string; info?: ModelInfo } {
  const ref = s.models.review;
  const provider = ref && isUsable(c, ref) ? findProvider(c, ref) : undefined;
  if (ref && provider) return { provider, model: ref.model, info: findModel(c, ref) };
  return cheapTarget(s, c, fallback);
}
