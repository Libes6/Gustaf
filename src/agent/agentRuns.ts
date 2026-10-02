import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../lib/api";
import { localDayKey } from "../lib/budgets";
import {
  AGENT_RUNS_SETTING, AGENT_USAGE_SETTING, EMPTY_LEDGER, addToLedger, appendStep, boundRuns, forPersist, isActiveStatus, mergeRuns, normalizeLedger, normalizeRuns,
  type AgentRun, type AgentUsageLedger, type TranscriptStep,
} from "./agentRunsModel";

// Background agent runs: one shared in-memory list (like rulesStore.ts), persisted shortly after each change in the app
// `settings` table under "agentRuns". Runs that were still active when the app stopped load as "interrupted".
let runs: AgentRun[] = [];
let loading: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let counter = 0;
const listeners = new Set<() => void>();
const stoppers = new Map<string, () => void>();

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const load = () => {
  loading ??= getSetting<unknown>(AGENT_RUNS_SETTING, [])
    .then((raw) => {
      runs = mergeRuns(normalizeRuns(raw), runs);
      emit();
      schedule(true); // persist the "interrupted" marks
    })
    .catch(() => {
      loading = undefined;
    });
  return loading;
};
async function persist() {
  await load();
  setSetting(AGENT_RUNS_SETTING, forPersist(runs)).catch(() => {});
}
/** Writes are batched: a run changes on every step. Finished states are written right away. */
function schedule(now = false) {
  clearTimeout(timer);
  timer = setTimeout(() => void persist(), now ? 0 : 1000);
}
const change = (next: AgentRun[], now = false) => {
  runs = next;
  emit();
  schedule(now);
};

/** Resolves once the persisted runs are loaded (active ones marked interrupted). */
export const loadAgentRuns = () => load();

export type NewRun = Pick<AgentRun, "title" | "type" | "providerId" | "model" | "projectRoot"> & { chatId?: number };

/** Registers a queued run; `stop` is called by `stopRun` and must make the run end soon. */
export function createRun(init: NewRun, stop: () => void): string {
  void load();
  const id = `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  stoppers.set(id, stop);
  change(boundRuns([{ ...init, id, status: "queued", createdAt: now, startedAt: 0, tokens: 0, toolUses: 0, currentStep: "", transcript: [] }, ...runs]));
  return id;
}

export function updateRun(id: string, patch: Partial<AgentRun>) {
  const finishing = patch.status !== undefined && !isActiveStatus(patch.status);
  if (finishing) stoppers.delete(id);
  change(runs.map((r) => (r.id === id ? { ...r, ...patch } : r)), finishing);
}

/** Adds to the counters and appends a transcript step in one update. */
export function recordStep(id: string, step: TranscriptStep | null, add: { tokens?: number; toolUses?: number } = {}, currentStep?: string) {
  change(
    runs.map((r) =>
      r.id !== id ? r : { ...r, tokens: r.tokens + (add.tokens ?? 0), toolUses: r.toolUses + (add.toolUses ?? 0), ...(currentStep !== undefined ? { currentStep } : {}), transcript: step ? appendStep(r.transcript, step) : r.transcript },
    ),
  );
}

export const getRun = (id: string) => runs.find((r) => r.id === id);
export const getRuns = () => runs;

export function stopRun(id: string) {
  stoppers.get(id)?.();
}

export function removeFinished(root?: string) {
  change(runs.filter((r) => isActiveStatus(r.status) || (root !== undefined && r.projectRoot !== root)), true);
}

// ---- subagent tokens for Budgets (persisted under "agentUsage") ----
let ledger: AgentUsageLedger = EMPTY_LEDGER;
let ledgerLoading: Promise<void> | undefined;
const loadLedger = () => {
  ledgerLoading ??= getSetting<unknown>(AGENT_USAGE_SETTING, null)
    .then((raw) => {
      const stored = normalizeLedger(raw);
      // Tokens recorded before the stored copy arrived are added on top of it.
      for (const [k, n] of Object.entries(ledger.days)) stored.days[k] = (stored.days[k] ?? 0) + n;
      for (const [k, n] of Object.entries(ledger.chats)) stored.chats[k] = (stored.chats[k] ?? 0) + n;
      ledger = stored;
    })
    .catch(() => {
      ledgerLoading = undefined;
    });
  return ledgerLoading;
};
/** Loads the stored ledger (Budgets awaits this before reading it). */
export const loadAgentUsage = () => loadLedger().then(() => ledger);
export const getAgentUsage = () => ledger;
export function recordAgentTokens(chatId: number | undefined, tokens: number, at = Date.now()) {
  if (!(tokens > 0)) return;
  ledger = addToLedger(ledger, localDayKey(at), chatId, tokens);
  void loadLedger().then(() => setSetting(AGENT_USAGE_SETTING, ledger).catch(() => {}));
}

/** Test helper: forget everything in memory (the persisted copy is left alone). */
export function resetAgentRuns() {
  clearTimeout(timer);
  runs = [];
  loading = undefined;
  ledger = EMPTY_LEDGER;
  ledgerLoading = undefined;
  stoppers.clear();
  emit();
}

/** All runs (newest first), or those of one project folder. */
export function useAgentRuns(root?: string | null): AgentRun[] {
  useEffect(() => void load(), []);
  const all = useSyncExternalStore(subscribe, () => runs);
  return root ? all.filter((r) => r.projectRoot === root) : all;
}
