// Reasoning effort levels per provider and model. Pure logic (only `import type`), unit-tested in tests/reasoning.test.mjs.
//
// Sources, checked 2026-10-06:
//  - Anthropic Messages API: `output_config.effort`. Opus 4.5: low..high; Opus/Sonnet 4.6: low, medium, high, max;
//    Opus 4.7+ / Opus 5.x / Sonnet 5.x / Fable / Mythos: low, medium, high, xhigh, max. Haiku 4.5 and Sonnet 4.5 reject it.
//  - Claude Code CLI: `--effort <low|medium|high|xhigh|max>` (claude --help).
//  - Codex CLI: `-c model_reasoning_effort=<level>`; only low/medium/high are offered (every reasoning model takes them).
//  - Cursor Agent CLI: bracket overrides on the model id, e.g. `claude-opus-4-8[effort=high]` (cursor-agent --help).
//    Not run against a logged-in account: which models accept `effort` is a guess (Claude and GPT-5+ families).
//  - Cursor SDK (API-key adapter): `Cursor.models.list()` reports per-model `parameters`; the effort one is sent back as `model.params`.
//  - OpenRouter: models whose `supported_parameters` include `reasoning` take `reasoning: { effort }` (low/medium/high).
import type { EffortSpec, ModelInfo, Reasoning } from "./types";

/** Every level, weakest first; a model offers a subset in this order. */
export const ALL_LEVELS: readonly Reasoning[] = ["low", "medium", "high", "xhigh", "max"];
const BASIC: readonly Reasoning[] = ["low", "medium", "high"];
const NO_XHIGH: readonly Reasoning[] = ["low", "medium", "high", "max"];
const NONE: readonly Reasoning[] = [];

/** Anthropic model ids (`claude-opus-5-5`, `claude-sonnet-4-6`, `claude-opus-4-5-20251101`…). */
export function anthropicLevels(model: string): readonly Reasoning[] {
  const m = model.toLowerCase();
  if (/(fable|mythos)/.test(m)) return ALL_LEVELS;
  const v = /(opus|sonnet)-(\d+)(?:[-.](\d+))?/.exec(m);
  if (!v) return NONE;
  const [, family, majorText, minorText] = v;
  const major = Number(majorText);
  // A trailing date snapshot (`-20251101`) is not a minor version.
  const minor = minorText && minorText.length <= 2 ? Number(minorText) : 0;
  if (major >= 5) return ALL_LEVELS;
  if (major !== 4) return NONE;
  if (minor >= 7) return ALL_LEVELS;
  if (minor === 6) return NO_XHIGH;
  if (minor === 5 && family === "opus") return BASIC;
  return NONE;
}

/** Claude Code takes aliases (`default`, `opus`, `sonnet`, `haiku`) or full ids. */
export function claudeCliLevels(model: string): readonly Reasoning[] {
  const m = model.toLowerCase();
  if (m === "default" || m === "opus" || m === "sonnet" || m === "") return ALL_LEVELS;
  if (m.includes("haiku")) return NONE;
  return anthropicLevels(m);
}

export const codexLevels = (_model: string): readonly Reasoning[] => BASIC;

/** A Cursor id that already names its effort, e.g. `claude-opus-4-8-high`, `gpt-5.5-extra-high-fast`, `claude-fable-5-thinking-max`. */
const CURSOR_LEVEL_SUFFIX = /-(none|minimal|low|medium|high|xhigh|extra-high|max)(-fast)?$/;

/**
 * Cursor model ids from `--list-models`. Accounts list either one id per effort variant (`claude-opus-4-8-high`; the
 * level is chosen by picking the id, so no slider) or plain ids (`claude-opus-5-5`) that take a bracket override.
 * `auto` and Cursor's own models get no override.
 */
export function cursorLevels(model: string, listed?: Iterable<string>): readonly Reasoning[] {
  const m = model.toLowerCase();
  if (m.includes("[") || CURSOR_LEVEL_SUFFIX.test(m)) return NONE;
  // A plain id listed next to its own level variants (`gpt-5.2` beside `gpt-5.2-high`) belongs to the old scheme too.
  if (listed) for (const id of listed) if (id.toLowerCase().startsWith(`${m}-`) && CURSOR_LEVEL_SUFFIX.test(id.toLowerCase())) return NONE;
  return /^(claude-(opus|sonnet|fable|mythos)-|gpt-5|gpt-6)/.test(m) ? BASIC : NONE;
}

/**
 * Cursor model id with the effort override. `medium` sends the plain id (the model's own default), so a chat that
 * never touched the slider keeps exactly the request it made before.
 */
export function cursorModel(model: string, level: Reasoning | undefined, listed?: Iterable<string>): string {
  if (!level || level === "medium" || !cursorLevels(model, listed).includes(level)) return model;
  return `${model}[effort=${level}]`;
}

/** The level to send: the requested one when the model offers it, else the nearest offered one (ties go lower). */
export function pickLevel(level: Reasoning | undefined, levels: readonly Reasoning[]): Reasoning | undefined {
  if (!level || !levels.length) return undefined;
  if (levels.includes(level)) return level;
  const want = ALL_LEVELS.indexOf(level);
  return [...levels].sort((a, b) => Math.abs(ALL_LEVELS.indexOf(a) - want) - Math.abs(ALL_LEVELS.indexOf(b) - want) || ALL_LEVELS.indexOf(a) - ALL_LEVELS.indexOf(b))[0];
}

/** Reset target in the composer: `medium` when offered, else the middle level. */
export function defaultLevel(levels: readonly Reasoning[]): Reasoning | undefined {
  return levels.includes("medium") ? "medium" : levels[Math.floor((levels.length - 1) / 2)];
}

// ---- effort that the provider reports per model ----------------------------------------------------------------------

const VALUE_LEVEL: Record<string, Reasoning> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", "x-high": "xhigh", "extra-high": "xhigh", extra_high: "xhigh", max: "max" };

/** The effort parameter of a Cursor SDK model (`ModelListItem.parameters`), or undefined when it has none (or fewer than two usable stops). */
export function sdkEffort(parameters: unknown): EffortSpec | undefined {
  if (!Array.isArray(parameters)) return undefined;
  for (const p of parameters) {
    if (!p || typeof p.id !== "string" || !/effort|reasoning/i.test(p.id) || !Array.isArray(p.values)) continue;
    const values: Partial<Record<Reasoning, string>> = {};
    for (const v of p.values) {
      const raw = typeof v?.value === "string" ? v.value : "";
      const level = VALUE_LEVEL[raw.toLowerCase().replace(/\s+/g, "-")];
      if (level && !values[level]) values[level] = raw;
    }
    if (Object.keys(values).length >= 2) return { param: p.id, values };
  }
  return undefined;
}

/** OpenRouter lists `supported_parameters`; `reasoning` means the unified `reasoning.effort` field is honoured. */
export function openRouterEffort(supportedParameters: unknown): EffortSpec | undefined {
  if (!Array.isArray(supportedParameters) || !supportedParameters.includes("reasoning")) return undefined;
  return { param: "reasoning", values: { low: "low", medium: "medium", high: "high" } };
}

export const specLevels = (spec: EffortSpec | undefined): readonly Reasoning[] => (spec ? ALL_LEVELS.filter((l) => spec.values[l] !== undefined) : NONE);

// The last model list of each provider (fresh or cached) feeds this, so adapters know a model's effort without listing again.
const reported = new Map<string, Map<string, EffortSpec>>();
export function rememberEfforts(models: readonly ModelInfo[]) {
  // Replaces the entry of every provider present in `models`, so a partial refresh keeps the others.
  const next = new Map<string, Map<string, EffortSpec>>();
  for (const m of models) {
    if (!next.has(m.providerId)) next.set(m.providerId, new Map());
    if (m.effort) next.get(m.providerId)!.set(m.id, m.effort);
  }
  for (const [id, own] of next) reported.set(id, own);
}
export const reportedEffort = (providerId: string, model: string): EffortSpec | undefined => reported.get(providerId)?.get(model);
