import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../lib/api";
import { localDayKey } from "../lib/budgets";
import type { Part } from "../providers/types";
import { deleteFinished, loadMessages, loadReport, loadStoredRuns, migrateLegacyRuns, pruneRuns, saveMessage, saveRun } from "./agentRunsDb";
import {
  AGENT_USAGE_SETTING, EMPTY_LEDGER, addToLedger, appendStep, boundRuns, isActiveStatus, mergeRuns, normalizeLedger,
  type AgentRun, type AgentUsageLedger, type TranscriptStep,
} from "./agentRunsModel";
import { MAX_MESSAGES_PER_RUN, messageJson, noteJson, rowsToSteps, type MessageRow, type PreviousRun, type StoredRole } from "./agentTranscript";

// Background agent runs: one shared in-memory list (like rulesStore.ts) that mirrors the SQLite tables `agent_runs` and
// `agent_messages` (agentRunsDb.ts). Run rows are written right away when a run is created or finishes and shortly after
// other changes; every subagent message is written as it happens, so the full transcript survives a restart and is read
// lazily (`loadRunSteps`). Runs that were still active when the app stopped load as "interrupted".
let runs: AgentRun[] = [];
let loading: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let counter = 0;
const listeners = new Set<() => void>();
const stoppers = new Map<string, () => void>();
const dirty = new Set<string>();
const seqs = new Map<string, number>();
/** All writes go through one chain, so a run row is always written before its messages. */
let chain: Promise<unknown> = Promise.resolve();
const enqueue = (fn: () => Promise<unknown>) => {
  chain = chain.then(fn).catch(() => {});
  return chain;
};

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const load = () => {
  loading ??= (async () => {
    await migrateLegacyRuns().catch(() => []);
    const stored = await loadStoredRuns((id) => runs.some((r) => r.id === id));
    runs = mergeRuns(stored, runs);
    emit();
  })().catch(() => {
    loading = undefined;
  });
  return loading;
};
const flush = () => {
  clearTimeout(timer);
  for (const id of [...dirty]) {
    dirty.delete(id);
    const run = runs.find((r) => r.id === id);
    if (run) void enqueue(() => saveRun(run));
  }
};
/** Row writes are batched: a run changes on every step. Created and finished runs are written right away. */
function schedule(id: string, now = false) {
  dirty.add(id);
  clearTimeout(timer);
  if (now) flush();
  else timer = setTimeout(flush, 1000);
}
const change = (next: AgentRun[]) => {
  runs = next;
  emit();
};

/** Resolves once the stored runs are loaded (active ones marked interrupted). */
export const loadAgentRuns = () => load();

export type NewRun = Pick<AgentRun, "title" | "type" | "providerId" | "model" | "projectRoot"> & { chatId?: number };

/** Registers a queued run; `stop` is called by `stopRun` and must make the run end soon. */
export function createRun(init: NewRun, stop: () => void): string {
  void load();
  const id = `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  stoppers.set(id, stop);
  change(boundRuns([{ ...init, id, status: "queued", createdAt: now, startedAt: 0, tokens: 0, toolUses: 0, currentStep: "", transcript: [] }, ...runs]));
  schedule(id, true);
  void enqueue(() => pruneRuns());
  return id;
}

export function updateRun(id: string, patch: Partial<AgentRun>) {
  const finishing = patch.status !== undefined && !isActiveStatus(patch.status);
  if (finishing) stoppers.delete(id);
  change(runs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  schedule(id, finishing || patch.status !== undefined);
}

/** Adds to the counters and appends a transcript step in one update. A note is also stored as a transcript message. */
export function recordStep(id: string, step: TranscriptStep | null, add: { tokens?: number; toolUses?: number } = {}, currentStep?: string) {
  change(
    runs.map((r) =>
      r.id !== id ? r : { ...r, tokens: r.tokens + (add.tokens ?? 0), toolUses: r.toolUses + (add.toolUses ?? 0), ...(currentStep !== undefined ? { currentStep } : {}), transcript: step ? appendStep(r.transcript, step) : r.transcript },
    ),
  );
  schedule(id);
  if (step?.kind === "note") writeMessage(id, "note", noteJson(step.text, step.error), step.at);
}

function writeMessage(id: string, role: StoredRole, json: string, at: number) {
  const seq = seqs.get(id) ?? 0;
  if (seq >= MAX_MESSAGES_PER_RUN) return;
  seqs.set(id, seq + 1);
  void enqueue(() => saveMessage(id, seq, role, json, at));
}

/** Stores one message of the subagent's own history (the task prompt, an assistant reply or tool results), bounded per message. */
export function recordMessage(id: string, role: "user" | "assistant" | "tool", parts: readonly Part[], at = Date.now()) {
  writeMessage(id, role, messageJson(parts), at);
}

export const getRun = (id: string) => runs.find((r) => r.id === id);
export const getRuns = () => runs;

export function stopRun(id: string) {
  stoppers.get(id)?.();
}

export function removeFinished(root?: string) {
  const gone = runs.filter((r) => !(isActiveStatus(r.status) || (root !== undefined && r.projectRoot !== root)));
  for (const r of gone) {
    dirty.delete(r.id);
    seqs.delete(r.id);
  }
  change(runs.filter((r) => !gone.includes(r)));
  void enqueue(() => deleteFinished(root));
}

/** The stored messages of a run as transcript steps (waits for earlier writes, so a live run shows what was just recorded). */
export async function loadRunSteps(id: string): Promise<TranscriptStep[]> {
  await chain;
  return rowsToSteps(await loadMessages(id));
}

/** Everything a continuation needs from a finished run, or null when it is unknown. */
export async function loadPreviousRun(id: string): Promise<(PreviousRun & { chatId?: number }) | null> {
  await load();
  const run = getRun(id);
  if (!run) return null;
  await chain;
  const rows: MessageRow[] = await loadMessages(id).catch(() => []);
  const first = rows.find((r) => r.role === "user");
  const task = first ? rowsToSteps([first])[0]?.text : undefined;
  const report = (await loadReport(id).catch(() => "")) || run.report || run.summary || "";
  return { title: run.title, type: run.type, status: run.status, ...(run.error ? { error: run.error } : {}), ...(task ? { task } : {}), report, steps: rowsToSteps(rows), ...(run.chatId !== undefined ? { chatId: run.chatId } : {}) };
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

/** Test helper: forget everything in memory (the database is left alone). */
export function resetAgentRuns() {
  clearTimeout(timer);
  runs = [];
  loading = undefined;
  ledger = EMPTY_LEDGER;
  ledgerLoading = undefined;
  stoppers.clear();
  dirty.clear();
  seqs.clear();
  emit();
}
/** Test helper: resolves when every queued database write has run. */
export const settleAgentRunWrites = async () => {
  flush();
  await chain;
};

/** All runs (newest first), or those of one project folder. */
export function useAgentRuns(root?: string | null): AgentRun[] {
  useEffect(() => void load(), []);
  const all = useSyncExternalStore(subscribe, () => runs);
  return root ? all.filter((r) => r.projectRoot === root) : all;
}
