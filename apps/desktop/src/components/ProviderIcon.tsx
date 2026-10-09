import { Box, Cpu, Globe, MousePointer2, Server, Sparkles, SquareTerminal, Waypoints } from "lucide-react";
import type { CliId, ProviderKind } from "../providers/types";

const COLORS: Partial<Record<ProviderKind, string>> = {
  anthropic: "#e07a4f",
  openai: "var(--text)",
  openrouter: "#8fa3ff",
  cursor: "var(--text)",
};

/** Plain monochrome mark for Grok (xAI): a ring cut by a diagonal stroke, drawn in the text colour. */
function GrokMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--text)" }}
    >
      <path d="M17.5 6.5A8 8 0 1 0 19.4 15" />
      <path d="M20 4 9 15" />
    </svg>
  );
}

/** Neutral mark for Antigravity: an upward chevron over an orbit arc (not any vendor artwork). */
function AntigravityMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--text)" }}
    >
      <path d="M7 14 12 6l5 8" />
      <path d="M4 19c4-2.5 12-2.5 16 0" />
    </svg>
  );
}

export function ProviderIcon({ kind, cli, size = 16 }: { kind: ProviderKind; cli?: CliId; size?: number }) {
  const family =
    kind === "gemini"
      ? "gemini"
      : kind === "openai" || cli === "codex"
        ? "openai"
        : kind === "anthropic" || cli === "claude"
          ? "claude"
          : kind === "cursor" || cli === "cursor-agent"
            ? "cursor"
            : null;
  if (family)
    return (
      <img
        src={`/icons/${family}.svg`}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        className={family === "openai" || family === "cursor" ? "icon-mono" : undefined}
        style={{ flexShrink: 0 }}
      />
    );
  if (kind === "xai") return <GrokMark size={size} />;
  if (kind === "antigravity") return <AntigravityMark size={size} />;
  const color = COLORS[kind];
  const Icon =
    kind === "openai"
      ? Sparkles
      : kind === "anthropic"
        ? Waypoints
        : kind === "openrouter"
          ? Globe
          : kind === "ollama"
            ? Cpu
            : kind === "lmstudio"
              ? Server
              : kind === "cursor"
                ? MousePointer2
                : kind === "cli"
                  ? SquareTerminal
                  : Box;
  return <Icon size={size} style={{ color }} strokeWidth={1.8} />;
}
