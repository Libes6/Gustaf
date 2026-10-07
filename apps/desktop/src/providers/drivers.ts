// Provider "drivers": how the providers page and the model picker group provider instances. Claude, GPT / Codex,
// Cursor and Grok are pinned at the top in that order (shown even when nothing is configured); every other provider
// follows in its saved order. Derived from the saved configs only, so no data migration is involved.
import type { ProviderConfig } from "./types";

export type Driver = "claude" | "codex" | "cursor" | "grok";
export const PINNED: Driver[] = ["claude", "codex", "cursor", "grok"];
export const DRIVER_NAMES: Record<Driver, string> = {
  claude: "Claude",
  codex: "GPT / Codex",
  cursor: "Cursor",
  grok: "Grok",
};

const XAI = /^https:\/\/api\.x\.ai(?:\/|$)/i;

/** The pinned driver a provider belongs to, or null for the rest (OpenRouter, Gemini, local servers, custom endpoints). */
export function driverOf(p: Pick<ProviderConfig, "kind" | "cli" | "baseUrl">): Driver | null {
  if (p.kind === "anthropic" || p.cli === "claude") return "claude";
  if (p.kind === "openai" || p.cli === "codex") return "codex";
  if (p.kind === "cursor" || p.cli === "cursor-agent") return "cursor";
  // A custom OpenAI-compatible provider pointed at xAI counts as Grok too.
  if (p.kind === "xai" || (p.kind === "custom" && XAI.test(p.baseUrl ?? ""))) return "grok";
  return null;
}

/** Providers in display order: the pinned drivers' instances (each group in saved order), then the others. */
export function orderProviders<T extends Pick<ProviderConfig, "kind" | "cli" | "baseUrl">>(list: T[]): T[] {
  const rank = (p: T) => {
    const d = driverOf(p);
    return d ? PINNED.indexOf(d) : PINNED.length;
  };
  return list
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}
