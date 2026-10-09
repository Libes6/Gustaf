// Model routing glue between the agent settings and the configured providers: which models subagents can run on and
// which model compaction / commit messages use. The choice logic itself is pure (agent/agentSettings.ts).
import { cheapModelFor, type AgentSettings, type ModelRef } from "../agent/agentSettings";
import { cliSubagentSupport, type CliFailure } from "../agent/cliSubagentCore";
import { exhaustedUntil, markExhausted } from "../providers/cursorAccounts";
import { updatePool } from "../providers/cursorPoolStore";
import type { ProviderDirectory, ResolvedModel } from "../agent/subagents";
import { getAdapter } from "../providers";
import type { ModelInfo, ProviderConfig } from "../providers/types";

type Catalog = { providers: ProviderConfig[]; models: ModelInfo[] };

const findModel = (c: Catalog, ref: ModelRef) =>
  c.models.find((m) => m.providerId === ref.providerId && m.id === ref.model);
const findProvider = (c: Catalog, ref: ModelRef) => c.providers.find((p) => p.id === ref.providerId && !p.disabled);

/** CLI agents run their own tools (and approvals) in the folder, so they cannot host a subagent loop. */
export const runsOwnTools = (p: ProviderConfig) => p.kind === "cli" || p.kind === "cursor" || p.kind === "antigravity";

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

/**
 * The providers a task may name (`provider`, `role`, `fallbackProviders`): enabled API providers with a tool-capable model
 * and CLI agents whose adapter runs non-interactively (the Cursor SDK provider is refused with the reason).
 */
export function providerDirectory(c: Catalog): ProviderDirectory {
  const enabled = () => c.providers.filter((p) => !p.disabled);
  return {
    list: () => enabled().map((p) => ({ id: p.id, name: p.name, ...(runsOwnTools(p) ? { cli: true } : {}) })),
    async resolve(providerId, model) {
      const p = enabled().find((x) => x.id === providerId);
      if (!p) return { ok: false, reason: "it is missing or disabled." };
      const own = c.models.filter((m) => m.providerId === p.id);
      const cli = cliSubagentSupport(p);
      if (cli) {
        if (!cli.ok) return { ok: false, reason: cli.reason };
        if (model && model !== "default" && own.length && !own.some((m) => m.id === model))
          return {
            ok: false,
            reason: `model "${model}" is not one of its models (${own
              .slice(0, 8)
              .map((m) => m.id)
              .join(", ")}).`,
          };
        return {
          ok: true,
          kind: "cli",
          adapter: await getAdapter(p),
          cli: cli.cli,
          model: model ?? "default",
          name: p.name,
        };
      }
      const info = model ? own.find((m) => m.id === model) : own.find((m) => m.tools !== false);
      if (!info)
        return {
          ok: false,
          reason: model
            ? `model "${model}" is not one of its listed models.`
            : "it has no listed model with tool support; name one in `model`.",
        };
      if (info.tools === false) return { ok: false, reason: `model "${info.id}" has no tool support.` };
      return {
        ok: true,
        kind: "api",
        adapter: await getAdapter(p),
        supportsTools: info.tools,
        model: info.id,
        name: p.name,
      };
    },
  };
}

/** A CLI subagent hit a usage limit on a Cursor account of the rotation pool: park it until its reset, like a chat run does. Other failures change nothing. */
export async function parkCliAccount(info: {
  providerId: string;
  failure: CliFailure;
  message: string;
}): Promise<void> {
  const quota = info.failure.quota;
  if (info.failure.kind !== "quota" || !quota) return;
  await updatePool((pool) => markExhausted(pool, info.providerId, exhaustedUntil(quota, Date.now()), info.message));
}

/** Provider and model for compaction / commit messages: the cheap model when configured and usable, else the given one. */
export function cheapTarget(
  s: AgentSettings,
  c: Catalog,
  fallback: { provider: ProviderConfig; model: string },
): { provider: ProviderConfig; model: string; info?: ModelInfo } {
  const ref = cheapModelFor(s, { providerId: fallback.provider.id, model: fallback.model }, (r) => isUsable(c, r));
  const provider = findProvider(c, ref) ?? fallback.provider;
  const model = provider === fallback.provider && ref.providerId !== fallback.provider.id ? fallback.model : ref.model;
  return { provider, model, info: findModel(c, { providerId: provider.id, model }) };
}

/**
 * Provider and model for the AI review of changes: the model configured for the `review` agent type when it is usable
 * (Settings > Agents), else the cheap model, else the given one.
 */
export function reviewTarget(
  s: AgentSettings,
  c: Catalog,
  fallback: { provider: ProviderConfig; model: string },
): { provider: ProviderConfig; model: string; info?: ModelInfo } {
  const ref = s.models.review;
  const provider = ref && isUsable(c, ref) ? findProvider(c, ref) : undefined;
  if (ref && provider) return { provider, model: ref.model, info: findModel(c, ref) };
  return cheapTarget(s, c, fallback);
}
