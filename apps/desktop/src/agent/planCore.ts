// Pure logic of the chat modes (Ask / Plan / Agent): which tools a mode may use, the system-prompt addendum, parsing of the
// plan the agent ends a Plan-mode turn with, the instruction text built from an approved plan, and the per-chat mode map.
// No app imports (tests/planCore.test.mjs).
import { TYPE_TOOLS } from "./subagentCore";

export const CHAT_MODES = ["ask", "plan", "agent"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
export const DEFAULT_CHAT_MODE: ChatMode = "agent";
export const isChatMode = (v: unknown): v is ChatMode => CHAT_MODES.includes(v as ChatMode);

/** Tools a mode may call: Ask none, Plan the `plan` subagent type's read-only set, Agent everything (null). */
export const modeToolNames = (mode: ChatMode | undefined): readonly string[] | null =>
  mode === "ask" ? [] : mode === "plan" ? (TYPE_TOOLS.plan ?? []) : null;
export const modeAllowsTool = (mode: ChatMode | undefined, name: string) => {
  const allowed = modeToolNames(mode);
  return !allowed || allowed.includes(name);
};
export const modeBlockedMessage = (mode: ChatMode | undefined) =>
  mode === "ask"
    ? "Blocked: Ask mode has no tools. Answer from the conversation only."
    : "Blocked: Plan mode is read-only. Use read_file, list_dir or search, then finish with the plan.";

export const PLAN_FENCE = "gustaf-plan";
/** Fence name written by builds from before the rename; still parsed in old chats. */
export const LEGACY_PLAN_FENCE = "mcode-plan";

export const ASK_PROMPT =
  "Ask mode: you have no tools. Answer the question from the conversation and your knowledge; do not claim to have read files or run anything. If the answer needs the project's files, say so.";
export const PLAN_PROMPT = [
  "Plan mode: you may only read (read_file, list_dir, search). You cannot edit files, run commands or use other tools; do not try.",
  "Research the request, then END your reply with exactly one plan in a fenced block, nothing after it:",
  "```" + PLAN_FENCE,
  '{"title":"Short title","steps":[{"id":"1","text":"What to do","files":["path/relative/to/root"]}],"risks":["optional"],"questions":["optional open question"]}',
  "```",
  "Steps are concrete, ordered and small enough to check off; `files` lists the files each step touches (optional). The user approves the plan before anything is changed.",
].join("\n");
export const modePrompt = (mode: ChatMode | undefined) =>
  mode === "ask" ? ASK_PROMPT : mode === "plan" ? PLAN_PROMPT : "";

export type PlanStep = { id: string; text: string; files?: string[] };
export type Plan = { title: string; steps: PlanStep[]; risks?: string[]; questions?: string[] };

const strings = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];

/** Validates a parsed JSON value as a plan (steps may be plain strings); ids are renumbered, empty steps dropped. Null when no step is usable. */
export function normalizePlan(raw: unknown): Plan | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.steps)) return null;
  const steps: PlanStep[] = [];
  for (const s of r.steps) {
    const o = typeof s === "string" ? { text: s } : s && typeof s === "object" ? (s as Record<string, unknown>) : null;
    const text = o && typeof o.text === "string" ? o.text.trim() : "";
    if (!text) continue;
    const files = strings(o!.files);
    steps.push({ id: String(steps.length + 1), text, ...(files.length ? { files } : {}) });
  }
  if (!steps.length) return null;
  const risks = strings(r.risks);
  const questions = strings(r.questions);
  return {
    title: typeof r.title === "string" && r.title.trim() ? r.title.trim() : "Plan",
    steps,
    ...(risks.length ? { risks } : {}),
    ...(questions.length ? { questions } : {}),
  };
}

const FENCE = new RegExp(
  "```(?:" + PLAN_FENCE + "|" + LEGACY_PLAN_FENCE + ")[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```",
  "g",
);

/** The LAST plan block of a reply: the text before it, the plan and the text after. Null when absent or unparsable. */
export function extractPlan(text: string): { before: string; plan: Plan; after: string } | null {
  const hits = [...text.matchAll(FENCE)];
  const m = hits[hits.length - 1];
  if (!m) return null;
  let plan: Plan | null = null;
  try {
    plan = normalizePlan(JSON.parse(m[1]));
  } catch {
    plan = null;
  }
  return plan ? { before: text.slice(0, m.index), plan, after: text.slice(m.index! + m[0].length) } : null;
}

/** The plan as a fenced block (what the agent writes); round-trips through `extractPlan`. */
export const serializePlan = (plan: Plan) => "```" + PLAN_FENCE + "\n" + JSON.stringify(plan) + "\n```";

export const APPROVED_MARK = "Approved plan";
/** The user instruction an approved plan becomes. */
export function planToInstruction(plan: Plan): string {
  const lines = [
    `${APPROVED_MARK}: ${plan.title}`,
    "Carry out these steps in order. Stop and ask if something no longer fits.",
    "",
  ];
  for (const s of plan.steps) lines.push(`${s.id}. ${s.text}${s.files?.length ? ` (${s.files.join(", ")})` : ""}`);
  if (plan.risks?.length) lines.push("", "Risks to keep in mind:", ...plan.risks.map((x) => `- ${x}`));
  return lines.join("\n");
}

// ---- per-chat mode (settings key `chatModes`: { [chatId]: "ask" | "plan" }, Agent is the absence of an entry) ----

export const CHAT_MODES_SETTING = "chatModes";
export const MAX_STORED_MODES = 2000;
export type ChatModeMap = Record<string, ChatMode>;

export function normalizeChatModes(v: unknown): ChatModeMap {
  const out: ChatModeMap = {};
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [k, m] of Object.entries(v as Record<string, unknown>))
      if (/^\d+$/.test(k) && (m === "ask" || m === "plan")) out[k] = m;
  return out;
}
export const chatModeOf = (map: ChatModeMap, chatId: number | null): ChatMode =>
  chatId === null ? DEFAULT_CHAT_MODE : (map[String(chatId)] ?? DEFAULT_CHAT_MODE);
export function withChatMode(map: ChatModeMap, chatId: number, mode: ChatMode): ChatModeMap {
  const next = { ...map };
  if (mode === DEFAULT_CHAT_MODE) delete next[String(chatId)];
  else next[String(chatId)] = mode;
  const keys = Object.keys(next).sort((a, b) => Number(a) - Number(b));
  // Oldest chat ids go first when the map grows past its cap.
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_STORED_MODES))) delete next[k];
  return next;
}
