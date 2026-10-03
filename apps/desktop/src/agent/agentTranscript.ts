// Pure helpers for the persisted subagent transcript (tests/agentTranscript.test.mjs): bounding one message before it is
// written to `agent_messages`, turning stored rows back into display steps, and the seed of a "continue this agent" run.
// No Tauri or React imports.
import type { Part } from "../providers/types";
import { redactValue } from "../lib/exportChats";
import { summarizeCall } from "./actionLog";
import type { RunStatus, TranscriptStep } from "./agentRunsModel";
import { clip } from "./agentRunsModel";

/** Rows kept per run (the app stops writing after this; a run is far below it with the default budgets). */
export const MAX_MESSAGES_PER_RUN = 2_000;
export const MAX_TEXT_PART = 8_000;
export const MAX_RESULT_PART = 8_000;
export const MAX_ARGS_JSON = 4_000;
export const MAX_PARTS_PER_MESSAGE = 24;
/** Hard bound of one stored `parts_json` (characters). */
export const MAX_MESSAGE_JSON = 48_000;

export type StoredRole = "user" | "assistant" | "tool" | "note" | "step";
export type MessageRow = { seq: number; role: string; parts_json: string; created_at: number };

type Stored = Record<string, unknown>;

function boundPart(p: Part): Stored | null {
  switch (p.type) {
    case "text":
      return { type: "text", text: clip(p.text, MAX_TEXT_PART) };
    case "tool_call": {
      const json = JSON.stringify(p.args ?? {}) ?? "{}";
      return { type: "tool_call", id: p.id, name: p.name, args: json.length <= MAX_ARGS_JSON ? p.args ?? {} : { truncated: clip(json, MAX_ARGS_JSON) } };
    }
    case "tool_result":
      return { type: "tool_result", id: p.id, name: p.name, output: clip(p.output ?? "", MAX_RESULT_PART), ...(p.isError ? { isError: true } : {}) };
    case "image":
      return { type: "text", text: "[image omitted]" };
    default:
      return null; // activities are UI state of the main chat
  }
}

/** One message as stored: images and activity parts removed, long fields cut, secrets scrubbed, the whole thing bounded. */
export function messageJson(parts: readonly Part[]): string {
  const bounded = parts.slice(0, MAX_PARTS_PER_MESSAGE).map(boundPart).filter((p): p is Stored => !!p).map((p) => redactValue(p));
  const json = JSON.stringify(bounded);
  if (json.length <= MAX_MESSAGE_JSON) return json;
  // Still too big (many large parts): shrink every long string to an even share, which always fits.
  const share = Math.max(100, Math.floor(MAX_MESSAGE_JSON / Math.max(1, bounded.length) / 2) - 200);
  const shrunk = bounded.map((p) => ({
    ...p,
    ...(typeof p.text === "string" ? { text: clip(p.text, share) } : {}),
    ...(typeof p.output === "string" ? { output: clip(p.output, share) } : {}),
    ...(p.type === "tool_call" ? { args: { truncated: clip(JSON.stringify(p.args) ?? "", share) } } : {}),
  }));
  const out = JSON.stringify(shrunk);
  return out.length <= MAX_MESSAGE_JSON ? out : "[]";
}

export const noteJson = (text: string, error?: boolean) => JSON.stringify([{ type: "text", text: clip(text, MAX_TEXT_PART), ...(error ? { error: true } : {}) }]);

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};
const asParts = (json: string): Stored[] => {
  const v = parse(json);
  return Array.isArray(v) ? v.filter((p): p is Stored => !!p && typeof p === "object") : [];
};
const str = (v: unknown, n: number) => (typeof v === "string" ? clip(v, n) : "");

/** Display limits of the transcript dialog (the stored text is longer than the old clipped steps). */
export const STEP_TEXT = 4_000;
export const STEP_RESULT = 4_000;

/** Stored rows (oldest first) as transcript steps: assistant text, each tool call with its result, notes, and the task prompt. */
export function rowsToSteps(rows: readonly MessageRow[]): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  const open = new Map<string, { name: string; args: unknown; index: number }>();
  for (const row of rows) {
    const at = row.created_at;
    if (row.role === "step") {
      // Rows migrated from the old `agentRuns` setting hold one step object.
      const s = parse(row.parts_json) as Stored | null;
      if (s && (s.kind === "tool" || s.kind === "text" || s.kind === "note")) steps.push({ at, kind: s.kind, ...(typeof s.tool === "string" ? { tool: s.tool } : {}), text: str(s.text, STEP_TEXT), ...(typeof s.result === "string" ? { result: str(s.result, STEP_RESULT) } : {}), ...(s.error === true ? { error: true } : {}) });
      continue;
    }
    const parts = asParts(row.parts_json);
    if (row.role === "user") {
      const text = parts.map((p) => str(p.text, STEP_TEXT)).join("");
      if (text) steps.push({ at, kind: "note", text });
    } else if (row.role === "note") {
      for (const p of parts) steps.push({ at, kind: "note", text: str(p.text, STEP_TEXT), ...(p.error === true ? { error: true } : {}) });
    } else if (row.role === "assistant") {
      const text = parts.filter((p) => p.type === "text").map((p) => str(p.text, STEP_TEXT)).join("").trim();
      if (text) steps.push({ at, kind: "text", text });
      for (const p of parts) {
        if (p.type !== "tool_call" || typeof p.id !== "string") continue;
        const name = str(p.name, 60);
        open.set(p.id, { name, args: p.args, index: steps.length });
        steps.push({ at, kind: "tool", tool: name, text: summarizeCall(name, p.args) });
      }
    } else if (row.role === "tool") {
      for (const p of parts) {
        if (p.type !== "tool_result") continue;
        const call = typeof p.id === "string" ? open.get(p.id) : undefined;
        const patch = { result: str(p.output, STEP_RESULT), ...(p.isError === true ? { error: true } : {}) };
        if (call) Object.assign(steps[call.index], patch);
        else steps.push({ at, kind: "tool", tool: str(p.name, 60), text: str(p.name, 60), ...patch });
      }
    }
  }
  return steps;
}

// ---- "Continue this agent" ----

/** Finished runs that can be continued: it must have ended on its own (not cancelled/interrupted) and not still run. */
export const CONTINUABLE: readonly RunStatus[] = ["completed", "failed", "limit", "budget"];
export const canContinue = (status: RunStatus) => CONTINUABLE.includes(status);

export const MAX_SEED_PROMPT = 2_000;
export const MAX_SEED_REPORT = 3_000;
export const MAX_SEED_STEPS = 40;
export const MAX_SEED_CHARS = 9_000;

export type PreviousRun = {
  title: string;
  type: string;
  status: RunStatus;
  error?: string;
  /** The first message of the previous run (its task). */
  task?: string;
  /** Its final report. */
  report?: string;
  steps: readonly TranscriptStep[];
};

/**
 * The prompt of a continuation run: what the previous run was asked, which tool calls it made (one line each, the newest
 * ones when there are many), how it ended, its report, then the follow-up. It is data from a previous run, not new
 * instructions, apart from the follow-up. Bounded.
 */
export function continuationPrompt(prev: PreviousRun, followUp: string): string {
  const calls = prev.steps.filter((s) => s.kind === "tool");
  const shown = calls.slice(-MAX_SEED_STEPS);
  const lines = [
    `You are continuing an earlier subagent run "${prev.title}" (${prev.type}, ${prev.status}${prev.error ? `: ${clip(prev.error, 300)}` : ""}). You do not have its history, only this summary.`,
    "",
    "--- Earlier task ---",
    clip(prev.task?.trim() || "(not available)", MAX_SEED_PROMPT),
    "",
    `--- Earlier tool calls (${calls.length}${calls.length > shown.length ? `, newest ${shown.length} shown` : ""}) ---`,
    ...(shown.length ? shown.map((s) => `- ${s.tool ?? "tool"} ${clip(s.text, 160)}${s.error ? " (failed)" : ""}`) : ["(none)"]),
    "",
    "--- Earlier report ---",
    clip(prev.report?.trim() || "(the run produced no report)", MAX_SEED_REPORT),
    "",
  ];
  return `${clip(lines.join("\n"), MAX_SEED_CHARS)}\n\n--- Follow-up (your task now) ---\n${followUp.trim()}`;
}

/** The message put into the composer by "Continue this agent": it asks the main agent to call spawn_agent with `continue_from`. */
export const continueRequest = (run: { id: string; title: string; type: string }, followUp: string) =>
  `Continue the subagent run "${run.title}" (id ${run.id}): call spawn_agent with continue_from "${run.id}" and type "${run.type}", using this as the prompt:\n${followUp.trim()}`;
