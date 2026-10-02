// Pure model of the background-agent runs (tests/agentRuns.test.mjs): types, bounds, normalization of what was persisted,
// marking of runs interrupted by a restart, and small formatting helpers. The store in agentRuns.ts holds the state.
import { isAgentType, type AgentType } from "./subagentCore";

export const AGENT_RUNS_SETTING = "agentRuns";
export const MAX_RUNS = 50;
export const MAX_STEPS_IN_MEMORY = 200;
export const MAX_STEPS_PERSISTED = 60;
export const MAX_STEP_TEXT = 240;
export const MAX_SUMMARY = 1_500;

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "limit" | "interrupted";
const STATUSES: RunStatus[] = ["queued", "running", "completed", "failed", "cancelled", "limit", "interrupted"];
export const isActiveStatus = (s: RunStatus) => s === "queued" || s === "running";

export type TranscriptStep = {
  at: number;
  kind: "tool" | "text" | "note";
  /** Tool name for `tool` steps. */
  tool?: string;
  /** What was called, or the text said. */
  text: string;
  /** For tool steps: the (clipped) result. */
  result?: string;
  error?: boolean;
};

export type AgentRun = {
  id: string;
  title: string;
  type: AgentType;
  providerId: string;
  model: string;
  /** The project folder the run belongs to (original project, not a review copy). */
  projectRoot: string;
  chatId?: number;
  status: RunStatus;
  createdAt: number;
  /** When it started running (set when it leaves the queue). */
  startedAt: number;
  endedAt?: number;
  tokens: number;
  toolUses: number;
  currentStep: string;
  error?: string;
  /** Start of the final report (clipped). */
  summary?: string;
  /** Files changed in the private copy (writing agents). */
  changed?: string[];
  warnings?: string[];
  transcript: TranscriptStep[];
};

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
const text = (v: unknown, n: number) => (typeof v === "string" ? clip(v, n) : "");

export function normalizeStep(raw: unknown): TranscriptStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "tool" || r.kind === "text" || r.kind === "note" ? r.kind : null;
  if (!kind) return null;
  return {
    at: num(r.at),
    kind,
    ...(typeof r.tool === "string" ? { tool: clip(r.tool, 60) } : {}),
    text: text(r.text, MAX_STEP_TEXT),
    ...(typeof r.result === "string" ? { result: clip(r.result, MAX_STEP_TEXT) } : {}),
    ...(r.error === true ? { error: true } : {}),
  };
}

export function normalizeRun(raw: unknown): AgentRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id || !isAgentType(r.type) || !STATUSES.includes(r.status as RunStatus)) return null;
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max).map((x) => clip(x, 500)) : undefined);
  const changed = strings(r.changed, 200);
  const warnings = strings(r.warnings, 10);
  return {
    id: r.id,
    title: text(r.title, 80) || "Agent",
    type: r.type,
    providerId: text(r.providerId, 100),
    model: text(r.model, 200),
    projectRoot: text(r.projectRoot, 1000),
    ...(typeof r.chatId === "number" ? { chatId: r.chatId } : {}),
    status: r.status as RunStatus,
    createdAt: num(r.createdAt),
    startedAt: num(r.startedAt),
    ...(typeof r.endedAt === "number" ? { endedAt: num(r.endedAt) } : {}),
    tokens: num(r.tokens),
    toolUses: num(r.toolUses),
    currentStep: text(r.currentStep, MAX_STEP_TEXT),
    ...(typeof r.error === "string" ? { error: clip(r.error, 1000) } : {}),
    ...(typeof r.summary === "string" ? { summary: clip(r.summary, MAX_SUMMARY) } : {}),
    ...(changed?.length ? { changed } : {}),
    ...(warnings?.length ? { warnings } : {}),
    transcript: (Array.isArray(r.transcript) ? r.transcript : []).map(normalizeStep).filter((s): s is TranscriptStep => !!s).slice(-MAX_STEPS_PERSISTED),
  };
}

/** Reads the persisted list. Runs that were queued or running belong to a previous app session: they are marked interrupted. */
export function normalizeRuns(raw: unknown, now = Date.now()): AgentRun[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeRun)
    .filter((r): r is AgentRun => !!r)
    .map((r) => (isActiveStatus(r.status) ? { ...r, status: "interrupted" as const, endedAt: r.endedAt ?? now, currentStep: "" } : r))
    .slice(0, MAX_RUNS);
}

/** Newest first; keeps every active run and the newest finished ones up to `max` in total. */
export function boundRuns(runs: readonly AgentRun[], max = MAX_RUNS): AgentRun[] {
  const sorted = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  const active = sorted.filter((r) => isActiveStatus(r.status));
  const room = Math.max(0, max - active.length);
  const keep = new Set([...active, ...sorted.filter((r) => !isActiveStatus(r.status)).slice(0, room)].map((r) => r.id));
  return sorted.filter((r) => keep.has(r.id));
}

/** Persisted copy: transcripts cut to the newest steps. */
export const forPersist = (runs: readonly AgentRun[]): AgentRun[] => boundRuns(runs).map((r) => ({ ...r, transcript: r.transcript.slice(-MAX_STEPS_PERSISTED) }));

/** Loaded (already interruption-marked) runs merged under the in-memory ones of this session, which win by id. */
export function mergeRuns(loaded: readonly AgentRun[], memory: readonly AgentRun[]): AgentRun[] {
  const ids = new Set(memory.map((r) => r.id));
  return boundRuns([...memory, ...loaded.filter((r) => !ids.has(r.id))]);
}

export const appendStep = (steps: readonly TranscriptStep[], step: TranscriptStep): TranscriptStep[] =>
  steps.length >= MAX_STEPS_IN_MEMORY ? [...steps.slice(steps.length - MAX_STEPS_IN_MEMORY + 1), step] : [...steps, step];

export const runTokens = (u?: { input: number; output: number }) => (u ? Math.max(0, u.input) + Math.max(0, u.output) : 0);

/** `m:ss` (or `h:mm:ss`) elapsed time of a run; queued runs show nothing. */
export function elapsed(run: Pick<AgentRun, "status" | "startedAt" | "endedAt">, now: number): string {
  if (run.status === "queued" || !run.startedAt) return "";
  const s = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

// ---- token ledger for Budgets ----
// Subagent replies are not stored as chat messages, so the budget gauge (which reads stored messages) would miss them.
// Their tokens are added here per local day and per parent chat, persisted under "agentUsage", bounded.
export const AGENT_USAGE_SETTING = "agentUsage";
export const MAX_LEDGER_DAYS = 31;
export const MAX_LEDGER_CHATS = 300;
export type AgentUsageLedger = { days: Record<string, number>; chats: Record<string, number> };
export const EMPTY_LEDGER: AgentUsageLedger = { days: {}, chats: {} };

const counts = (v: unknown, max: number, keyOk: (k: string) => boolean) => {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(-max)) if (keyOk(k) && typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  return out;
};
export const normalizeLedger = (raw: unknown): AgentUsageLedger => {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { days: counts(r.days, MAX_LEDGER_DAYS, (k) => /^\d{4}-\d{2}-\d{2}$/.test(k)), chats: counts(r.chats, MAX_LEDGER_CHATS, (k) => /^c\d+$/.test(k)) };
};

/** Adds `tokens` to the day and (when known) the chat; the oldest days and least recently used chats fall off. */
export function addToLedger(l: AgentUsageLedger, dayKey: string, chatId: number | undefined, tokens: number): AgentUsageLedger {
  if (!(tokens > 0)) return l;
  const days: Record<string, number> = { ...l.days, [dayKey]: (l.days[dayKey] ?? 0) + Math.floor(tokens) };
  const keepDays = Object.keys(days).sort().slice(-MAX_LEDGER_DAYS);
  let chats = l.chats;
  if (chatId !== undefined) {
    const key = `c${chatId}`; // a prefix keeps insertion order (integer-like keys are sorted numerically)
    const { [key]: old = 0, ...rest } = l.chats;
    const moved: Record<string, number> = { ...rest, [key]: old + Math.floor(tokens) };
    chats = Object.fromEntries(Object.entries(moved).slice(-MAX_LEDGER_CHATS));
  }
  return { days: Object.fromEntries(keepDays.map((k) => [k, days[k]])), chats };
}
export const ledgerDay = (l: AgentUsageLedger, dayKey: string) => l.days[dayKey] ?? 0;
export const ledgerChat = (l: AgentUsageLedger, chatId: number | null | undefined) => (chatId == null ? 0 : l.chats[`c${chatId}`] ?? 0);
