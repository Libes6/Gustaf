export type TokenUsage = { input: number; output: number; cached: number; cacheWrite: number; reasoning: number };
export type LimitWindow = { id: string; label: string; usedPercent: number; resetsAt?: number; plan?: string };
import type { CuAction } from "../lib/api";
import type { RetryInfo } from "./retry";

/** Lifecycle of a CLI-native subagent (Codex `collab_tool_call`, Claude Code `Task`/`Agent`), see providers/activities.ts. `stopped`: interrupted or cut off (the turn or the whole run ended first); neutral, not a failure. */
export type SubagentState = "running" | "waiting" | "completed" | "failed" | "stopped";
/** One CLI-native subagent as shown in the "Subagents" card and the agents panel. Action `progress` is only used for patches from the subagent's own events; `scan` marks entries read from Codex's rollout files, whose cumulative counters supplement stream lifecycle updates. */
export type SubagentInfo = {
  provider: "codex" | "claude";
  /** Codex thread id or Claude `tool_use` id; empty while a Codex spawn is still in flight. */
  agentId: string;
  /** Canonical Codex task path, also accepted by collaboration tools. */
  agentPath?: string;
  /** Empty when the CLI gave the agent no name (the UI then shows a short id). */
  title: string;
  /** Claude background `Task`: the id the CLI gave the launched agent; its later completion notice names this id (or the `tool_use` id). */
  bgId?: string;
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
  /** Latest genuine Codex task_started, distinct from the thread creation time. */
  turnStartedAt?: number;
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
    /** Copied history needs its inline images when replayed into a fresh native session. */
    branchHistory?: boolean;
    checkpoint?: string;
    imported?: string;
    durationMs?: number;
    usage?: TokenUsage;
    compacted?: boolean;
  };
};

/** `xai` (Grok) is an OpenAI-compatible preset served by the generic OpenAI-compatible adapter. */
export type ProviderKind = "openai" | "gemini" | "anthropic" | "openrouter" | "ollama" | "lmstudio" | "custom" | "cursor" | "cli" | "xai";
export type CliId = "claude" | "cursor-agent" | "codex";
export type ProviderConfig = { id: string; kind: ProviderKind; name: string; baseUrl: string; cli?: CliId; cliAuth?: "key"; /** Isolated cursor-agent profile (folder name under the app data dir) of a browser-login Cursor account. */ cliProfile?: string; /** Legacy single backup, migrated into the Cursor account pool (providers/cursorAccounts.ts). */ backupProviderId?: string; disabled?: boolean };
export type ModelInfo = { id: string; name: string; providerId: string; created: number; contextWindow?: number; images?: boolean; tools?: boolean };
export type ToolDef = { name: string; description: string; parameters: Record<string, unknown> };
export type Reasoning = "low" | "medium" | "high" | "xhigh" | "max";
/** Levels of an adapter that only says it supports reasoning (no `reasoningLevels`), weakest first. */
export const REASONING_LEVELS: readonly Reasoning[] = ["low", "medium", "high"];
export const DEFAULT_REASONING: Reasoning = "medium";

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
  /** Chat mode: CLI adapters pass their native plan / read-only flags for "plan" and "ask". */
  mode?: "ask" | "plan" | "agent";
  /** CLI adapters: on abort kill the CLI's whole process tree, not only the process itself (used by CLI subagents). */
  killTree?: boolean;
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
  /** Effort levels this model offers, weakest first (empty: no control). Absent: `REASONING_LEVELS` when `supportsReasoning`. */
  reasoningLevels?(model: string, listed?: readonly string[]): readonly Reasoning[];
}

/** Levels to show for a model, whichever way the adapter reports them. */
export const levelsOf = (a: Pick<Adapter, "supportsReasoning" | "reasoningLevels">, model: string, listed?: readonly string[]): readonly Reasoning[] =>
  a.reasoningLevels ? a.reasoningLevels(model, listed) : a.supportsReasoning(model) ? REASONING_LEVELS : [];

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
