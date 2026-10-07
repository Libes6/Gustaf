import type { ProviderConfig } from "../providers/types";
import { ProviderIcon } from "./ProviderIcon";
export function modelFamily(model: string, provider?: ProviderConfig) {
  if (/claude|sonnet|opus|haiku/i.test(model) || provider?.kind === "anthropic" || provider?.cli === "claude")
    return "claude";
  if (/gemini|gemma/i.test(model)) return "gemini";
  if (/gpt|codex|openai|(?:^|\/)o[134](?:-|$)/i.test(model) || provider?.kind === "openai" || provider?.cli === "codex")
    return "openai";
  return null;
}
export function ModelIcon({ model, provider, size = 16 }: { model: string; provider?: ProviderConfig; size?: number }) {
  const family = modelFamily(model, provider);
  return family ? (
    <img src={`/icons/${family}.svg`} alt="" aria-hidden="true" width={size} height={size} style={{ flexShrink: 0 }} />
  ) : (
    <ProviderIcon kind={provider?.kind ?? "custom"} cli={provider?.cli} size={size} />
  );
}
