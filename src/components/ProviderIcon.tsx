import { Box, Cpu, Globe, MousePointer2, Server, Sparkles, SquareTerminal, Waypoints } from "lucide-react";
import type { CliId, ProviderKind } from "../providers/types";

const COLORS: Partial<Record<ProviderKind, string>> = { anthropic: "#e07a4f", openai: "#e6e6e6", openrouter: "#8fa3ff", cursor: "#e6e6e6" };

export function ProviderIcon({ kind, cli, size = 16 }: { kind: ProviderKind; cli?: CliId; size?: number }) {
  const family = kind === "gemini" ? "gemini" : kind === "openai" || cli === "codex" ? "openai" : kind === "anthropic" || cli === "claude" ? "claude" : kind === "cursor" || cli === "cursor-agent" ? "cursor" : null;
  if (family) return <img src={`/icons/${family}.svg`} alt="" aria-hidden="true" width={size} height={size} style={{ flexShrink: 0 }} />;
  const color = COLORS[kind];
  const Icon =
    kind === "openai" ? Sparkles
    : kind === "anthropic" ? Waypoints
    : kind === "openrouter" ? Globe
    : kind === "ollama" ? Cpu
    : kind === "lmstudio" ? Server
    : kind === "cursor" ? MousePointer2
    : kind === "cli" ? SquareTerminal
    : Box;
  return <Icon size={size} color={color} strokeWidth={1.8} />;
}
