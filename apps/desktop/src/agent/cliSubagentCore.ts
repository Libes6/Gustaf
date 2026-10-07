// Pure parts of CLI subagents (tests/cliSubagent.test.mjs): which providers can host a subagent, the access level a CLI
// subagent gets, classification of CLI failures (quota, rate limit, sign-in), the collector that turns the adapter's
// text and activity stream into a report and a call count, the mapping of an activity to a transcript step, and the
// system prompt. The runtime is in subagents.ts. Only `import type` from app modules is allowed (Node runs this file).
import type { CliId, Part } from "../providers/types";
import { classifyQuota, type Quota } from "../providers/cursorAccounts";
import { clip, MAX_STEP_TEXT, type TranscriptStep } from "./agentRunsModel";
import { isReadOnlyType, type AgentType } from "./subagentCore";

type Activity = Extract<Part, { type: "activity" }>;

/** CLIs whose adapter runs non-interactively (`claude -p`, `codex exec`, `cursor-agent -p`) and has a read-only flag set. */
export const NON_INTERACTIVE_CLIS: readonly CliId[] = ["claude", "cursor-agent", "codex"];

export type CliSupport = { ok: true; cli: CliId } | { ok: false; reason: string };

/**
 * null: an API provider (the subagent loop runs here). Otherwise whether the provider's adapter can host a CLI subagent.
 * The Cursor SDK provider (kind `cursor`) cannot: its sidecar takes no access level, so a task could neither be kept
 * read-only nor sandboxed to its worktree. Use a Cursor Agent CLI account instead.
 */
export function cliSubagentSupport(p: { kind: string; cli?: string; name?: string }): CliSupport | null {
  const name = p.name ?? p.cli ?? p.kind;
  if (p.kind === "cli") {
    return NON_INTERACTIVE_CLIS.includes(p.cli as CliId)
      ? { ok: true, cli: p.cli as CliId }
      : { ok: false, reason: `${name} cannot run non-interactively, so it cannot be used for subagents.` };
  }
  if (p.kind === "cursor")
    return {
      ok: false,
      reason: `${name} (the Cursor SDK) cannot run non-interactively with a read-only or sandboxed access level, so it cannot be used for subagents; use a Cursor Agent CLI account.`,
    };
  return null;
}

/**
 * Access of a CLI subagent: the CLI's own read-only sandbox / plan mode for read-only types, otherwise at most "auto"
 * (edits inside the worktree; Codex `workspace-write`, Claude `acceptEdits`, Cursor without `--force`). Never "full":
 * that would bypass the sandbox and the approvals nobody can answer.
 */
export const cliAccess = (type: AgentType, parent: "readonly" | "auto" | "full" | undefined): "readonly" | "auto" =>
  isReadOnlyType(type) || parent === "readonly" ? "readonly" : "auto";

// ---- worktrees ----

/** The git worktree of one CLI subagent task (branch `gustaf/<slug>`, see lib/worktrees.ts). */
export type SubagentWorkspace = {
  taskId: string;
  branch: string;
  /** Where the CLI runs: the checkout, at the project's subfolder when the project is not the repository root. */
  cwd: string;
  /** The checkout folder. */
  path: string;
  baseCommit: string;
};
export type WorktreeSetup = {
  access: "readonly" | "auto" | "full";
  allowlist: string[];
  approve: (command: string) => Promise<boolean>;
};
/** What the runtime needs from git worktrees; lib/subagentWorktrees.ts implements it, tests pass a fake. */
export type SubagentWorktrees = {
  /** Null when the project is not a usable git repository (the task then runs in a shadow copy). Rejects for other failures. */
  create(a: {
    projectRoot: string;
    title: string;
    providerId: string;
    model: string;
    setup: WorktreeSetup;
  }): Promise<SubagentWorkspace | null>;
  /** Net change of the checkout against its base: the changed files, and whether anything happened at all (edits or commits). */
  inspect(projectRoot: string, taskId: string): Promise<{ files: string[]; touched: boolean }>;
  /** Removes the checkout and its branch; false when it could not be removed (nothing is forced). */
  remove(projectRoot: string, taskId: string): Promise<boolean>;
};

// ---- failures ----

export type CliFailureKind = "quota" | "rate_limit" | "auth" | "other";
export type CliFailure = {
  kind: CliFailureKind;
  quota?: Quota;
  /** One short sentence for the report. */ reason: string;
};

const AUTH =
  /\b401\b|unauthori[sz]ed|authenticat|not logged in|not signed in|invalid api key|api key (?:is )?(?:missing|invalid|required)|(?:claude auth|cursor-agent|codex) login|please (?:log ?in|sign ?in)/i;
const RATE = /rate[ -]?limit|too many requests|\b429\b|overloaded/i;
const firstLine = (s: string) =>
  clip(
    s
      .trim()
      .split("\n")
      .find((l) => l.trim()) ?? "",
    200,
  );

/** What kind of failure a CLI run's error message is. Quota detection is the Cursor pool's (providers/cursorAccounts.ts), applied to every CLI. */
export function classifyCliFailure(message: string, now = Date.now()): CliFailure {
  const text = message.slice(0, 4000);
  const quota = classifyQuota(text, now);
  if (quota) return { kind: "quota", quota, reason: `quota or usage limit reached (${firstLine(text)})` };
  if (AUTH.test(text)) return { kind: "auth", reason: `not signed in or not authorized (${firstLine(text)})` };
  if (RATE.test(text)) return { kind: "rate_limit", reason: `rate limited (${firstLine(text)})` };
  return { kind: "other", reason: firstLine(text) || "the CLI failed" };
}

/** Quota, rate limit and sign-in problems are provider-specific: the next attempt moves to the next fallback provider. */
export const movesToFallback = (k: CliFailureKind | undefined) => k === "quota" || k === "rate_limit" || k === "auth";

/** The provider of attempt `n` (1-based) of a task: it moves one step along `chain` after each failure of a provider-specific kind, and stays on the last entry. */
export function chainIndex(kinds: readonly (CliFailureKind | undefined)[], length: number): number {
  let i = 0;
  for (const k of kinds) if (movesToFallback(k)) i = Math.min(i + 1, Math.max(0, length - 1));
  return i;
}

// ---- stream to report ----

const activityKey = (a: Activity) => a.id || `${a.name}:${JSON.stringify(a.args ?? {})}`;

/**
 * Collects what a CLI says and does. The report is the text after the last new tool call (the final message), or the
 * last text before it when the run ended on a tool call. A call is counted once, however often its activity updates.
 */
export function createCliCollector() {
  const seen = new Set<string>();
  const segments: string[] = [""];
  let flushed = 0;
  return {
    /** Text segments not handed out yet (the open one only with `all`), for the persisted transcript. */
    flush(all = false): string[] {
      const end = all ? segments.length : segments.length - 1;
      const out = segments
        .slice(flushed, end)
        .map((s) => s.trim())
        .filter(Boolean);
      flushed = Math.max(flushed, end);
      return out;
    },
    text(delta: string) {
      segments[segments.length - 1] += delta;
    },
    /** True when this is the first sight of the activity (a new call). */
    activity(a: Activity): boolean {
      const key = activityKey(a);
      if (seen.has(key)) return false;
      seen.add(key);
      if (segments[segments.length - 1].trim()) segments.push("");
      return true;
    },
    toolCalls: () => seen.size,
    final(): string {
      for (let i = segments.length - 1; i >= 0; i--) if (segments[i].trim()) return segments[i].trim();
      return "";
    },
    all: () => segments.join("\n\n").trim(),
  };
}

const MAX_DESC = 160;
/** What a call did, in one line: the command, path, pattern or query of its arguments. */
export function describeActivity(a: Pick<Activity, "name" | "args">): string {
  const args = (a.args ?? {}) as Record<string, unknown>;
  const pick = [
    args.command,
    args.file_path,
    args.path,
    args.pattern,
    args.query,
    args.url,
    args.description,
    args.prompt,
    args.tool,
  ].find((v) => v !== undefined && v !== null && v !== "");
  const text = typeof pick === "string" ? pick : pick === undefined ? "" : JSON.stringify(pick);
  return clip(text.replace(/\s+/g, " ").trim(), MAX_DESC);
}

/** A finished (or cut off) call as a transcript step of the background-tasks panel. */
export function activityStep(a: Activity, at: number): TranscriptStep {
  const desc = describeActivity(a);
  return {
    at,
    kind: "tool",
    tool: a.name || "tool",
    text: clip(desc || a.name || "tool", MAX_STEP_TEXT),
    ...(a.output ? { result: a.output.slice(0, 400) } : {}),
    ...(a.status === "error" ? { error: true } : {}),
  };
}

/** The short "current step" shown while a call runs. */
export const activityLabel = (a: Pick<Activity, "name" | "args">) =>
  `${a.name || "tool"} ${describeActivity(a)}`.trim();

// ---- prompts ----

const COMMON =
  "You are a subagent started by the main Gustaf agent for one task. You run non-interactively: you cannot ask the user questions, cannot see the main conversation and nobody can approve anything, so never wait for input or permission. Your final message is your report: the main agent receives only that, so put the results in it, concisely (under 400 words), with project-relative file paths.";
const TYPE_PROMPT: Record<AgentType, string> = {
  explore:
    "You are read-only: investigate the code and report what you found (paths and line numbers). Do not modify files and do not run commands that change anything.",
  plan: "You are read-only: study the code and return a concrete, ordered implementation plan (files to change, what to change, risks). Do not modify files.",
  review:
    "You are read-only: review the code or changes named in the task for bugs, regressions and missing tests. List findings by severity with file and line. Say so if you found nothing. Do not modify files.",
  general:
    "You may edit files, but only inside your working directory: it is your own git worktree on its own branch. Do not commit, switch branches, merge or push, and do not touch anything outside the working directory. Finish by listing what you changed and what you could not verify.",
};
/** System text of a CLI subagent (CLIs get it in front of the task prompt). Keeps the phrase "You are a subagent" that marks subagent turns. */
export function cliSubagentSystem(type: AgentType, files: readonly string[]): string {
  return [COMMON, TYPE_PROMPT[type], files.length ? `Focus on: ${files.join(", ")}.` : ""].filter(Boolean).join("\n");
}
