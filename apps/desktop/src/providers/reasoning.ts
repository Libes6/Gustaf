// Reasoning effort levels per provider and model. Pure logic (only `import type`), unit-tested in tests/reasoning.test.mjs.
//
// Sources, checked 2026-10-06:
//  - Anthropic Messages API: `output_config.effort`. Opus 4.5: low..high; Opus/Sonnet 4.6: low, medium, high, max;
//    Opus 4.7+ / Opus 5.x / Sonnet 5.x / Fable / Mythos: low, medium, high, xhigh, max. Haiku 4.5 and Sonnet 4.5 reject it.
//  - Claude Code CLI: `--effort <low|medium|high|xhigh|max>` (claude --help).
//  - Codex CLI: `-c model_reasoning_effort=<level>`; only low/medium/high are offered (every reasoning model takes them).
//  - Cursor Agent CLI: bracket overrides on the model id, e.g. `claude-opus-4-8[effort=high]` (cursor-agent --help).
//    Not run against a logged-in account: which models accept `effort` is a guess (Claude and GPT-5+ families).
import type { Reasoning } from "./types";

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

/** Cursor model ids from `--list-models`; `auto` and Cursor's own models get no override. */
export function cursorLevels(model: string): readonly Reasoning[] {
  const m = model.toLowerCase();
  if (m.includes("[")) return NONE;
  return /^(claude-|opus|sonnet|gpt-5|gpt-6)/.test(m) && !m.includes("haiku") ? BASIC : NONE;
}

/**
 * Cursor model id with the effort override. `medium` sends the plain id (the model's own default), so a chat that
 * never touched the slider keeps exactly the request it made before.
 */
export function cursorModel(model: string, level: Reasoning | undefined): string {
  if (!level || level === "medium" || !cursorLevels(model).includes(level)) return model;
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
