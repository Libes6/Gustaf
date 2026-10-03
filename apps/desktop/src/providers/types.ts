export type TokenUsage = { input: number; output: number; cached: number; cacheWrite: number; reasoning: number };
export type LimitWindow = { id: string; label: string; usedPercent: number; resetsAt?: number; plan?: string };
import type { CuAction } from "../lib/api";
import type { RetryInfo } from "./retry";

/** Lifecycle of a CLI-native subagent (Codex `collab_tool_call`, Claude Code `Task`/`Agent`), see providers/activities.ts. */
export type SubagentState = "running" | "waiting" | "completed" | "failed";
/** One CLI-native subagent as shown in the "Subagents" card and the agents panel. Action `progress` is only used for patches from the subagent's own events; `scan` marks entries read from Codex's rollout files, whose values replace the old ones. */
export type SubagentInfo = {
  provider: "codex" | "claude";
  /** Codex thread id or Claude `tool_use` id; empty while a Codex spawn is still in flight. */
  agentId: string;
  /** Empty when the CLI gave the agent no name (the UI then shows a short id). */
  title: string;
  /** Claude `subagent_type`. */
  role?: string;
  action: "spawn" | "wait" | "send" | "close" | "task" | "progress" | "scan";
  state: SubagentState;
  /** Short summary of the task given to the agent. */
  prompt?: string;
  /** Short summary of its latest message or report (the full text is the activity's `output`). */
  result?: string;
  /** Number of finished `wait` calls for this agent (merged into one entry). */
  waits?: number;
  /** Claude: tool calls the subagent made (counted from its events). Codex: shell calls in its rollout file. */
  toolUses?: number;
  /** Its latest tool call. */
  step?: string;
  /** Codex rollout scan only (providers/codexRollout.ts): total tokens, start and end (Unix ms) and run time. */
  tokens?: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
};

export type Part =
  | { type: "activity"; id: string; name: string; args: Record<string, any>; status: "running" | "success" | "error" | "unknown"; output?: string; subagent?: SubagentInfo }
  | { type: "text"; text: string }
  | { type: "image"; data: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: any;
      computer?: { actions: CuAction[]; safetyChecks?: { id: string; code?: string; message?: string }[] };
    }
  | { type: "tool_result"; id: string; name: string; output: string; image?: string; isError?: boolean; computer?: boolean };

export type Msg = {
  role: "user" | "assistant" | "tool";
  parts: Part[];
  meta?: {
    provider?: string;
    model?: string;
    responseId?: string;
    checkpoint?: string;
    imported?: string;
    durationMs?: number;
    usage?: TokenUsage;
    compacted?: boolean;
  };
};

export type ProviderKind = "openai" | "gemini" | "anthropic" | "openrouter" | "ollama" | "lmstudio" | "custom" | "cursor" | "cli";
export type CliId = "claude" | "cursor-agent" | "codex";
export type ProviderConfig = { id: string; kind: ProviderKind; name: string; baseUrl: string; cli?: CliId; cliAuth?: "key"; /** Isolated cursor-agent profile (folder name under the app data dir) of a browser-login Cursor account. */ cliProfile?: string; /** Legacy single backup, migrated into the Cursor account pool (providers/cursorAccounts.ts). */ backupProviderId?: string; disabled?: boolean };
export type ModelInfo = { id: string; name: string; providerId: string; created: number; contextWindow?: number; images?: boolean; tools?: boolean };
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type Reasoning = "low" | "medium" | "high";

export type TurnInput = {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  model: string;
  reasoning?: Reasoning;
  computer?: { width: number; height: number };
  cwd?: string;
  /** Chat the turn belongs to; CLI adapters use it to place image attachments on disk. */
  chatId?: number;
  access?: "readonly" | "auto" | "full";
  signal: AbortSignal;
  onText: (delta: string) => void;
  onActivity?: (part: Extract<Part, { type: "activity" }>) => void;
  onLimits?: (windows: LimitWindow[]) => void;
  /** API providers call this before waiting to retry a transient failure (429/5xx/network) that happened before any output. */
  onRetry?: (info: RetryInfo) => void;
};

export type TurnOutput = { parts: Part[]; responseId?: string; usage?: TokenUsage };

export interface Adapter {
  listModels(): Promise<ModelInfo[]>;
  turn(input: TurnInput): Promise<TurnOutput>;
  supportsComputer: boolean;
  supportsReasoning(model: string): boolean;
}

export const textOf = (m: Msg) =>
  m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

/** Renders a message as plain text, for providers that can't replay another provider's tool calls. */
export function flattenMsg(m: Msg): string {
  return m.parts
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "tool_call") return `[tool ${p.name} ${JSON.stringify(p.args).slice(0, 400)}]`;
      if (p.type === "tool_result") return `[result ${p.name}: ${p.output.slice(0, 1500)}]`;
      if (p.type === "activity") return `[${p.name}: ${p.status} ${p.output?.slice(0, 1500) ?? ""}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
