// The agent action log: one entry per tool call or command, kept in the app settings (see actionLogStore.ts).
// Pure helpers (no Tauri, no React) so they are unit-tested in tests/actionLog.test.mjs.
// Only what is needed to audit a run is stored: what was called, how it ended, what allowed or stopped it. Command text
// is scrubbed of secrets like exported chats are; outputs and file contents are never stored here.
import { redactSecrets } from "../lib/exportChats.ts";
import { isBlobId, type UndoRecord } from "../lib/fileUndo.ts";

export const ACTION_LOG_SETTING = "actionLog";
export const MAX_ENTRIES = 300;
const MAX_SUMMARY = 300;
const MAX_DETAIL = 240;

export type ActionStatus = "running" | "success" | "error" | "blocked" | "declined" | "cancelled" | "interrupted";
export type Approval = "rule" | "mode" | "user";
export type ActionEntry = {
  id: string;
  at: number;
  durationMs?: number;
  tool: string;
  summary: string;
  status: ActionStatus;
  /** Folder the call ran in (a review copy for writable projects). */
  root?: string;
  /** The project folder, when known. */
  project?: string;
  /** What let a command run: an allow rule, the access mode (full access / nothing matched) or the user. */
  approval?: Approval;
  /** The rule involved: the allow rule that matched, the ask rule that asked, or the deny rule that blocked. */
  rule?: string;
  builtin?: boolean;
  detail?: string;
  undo?: UndoRecord;
  /** `"scheduled"`: a call made by an unattended run (a scheduled prompt). `"hook"`: the entry is a hook run, see `hook`. */
  source?: "scheduled" | "hook";
  hook?: HookMeta;
};
/** What is recorded of a hook run (its output is the entry's `detail`). */
export type HookMeta = { event: string; command: string; exitCode?: number | null; timedOut?: boolean; scope?: "global" | "project" };

const STATUSES: readonly string[] = ["running", "success", "error", "blocked", "declined", "cancelled", "interrupted"];
const APPROVALS: readonly string[] = ["rule", "mode", "user"];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ⏎ ");

function normalizeHook(raw: unknown): HookMeta | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const h = raw as Record<string, unknown>;
  if (typeof h.event !== "string" || typeof h.command !== "string") return undefined;
  return {
    event: clip(h.event, 40),
    command: clip(h.command, MAX_SUMMARY),
    ...(typeof h.exitCode === "number" || h.exitCode === null ? { exitCode: h.exitCode as number | null } : {}),
    ...(h.timedOut === true ? { timedOut: true } : {}),
    ...(h.scope === "global" || h.scope === "project" ? { scope: h.scope } : {}),
  };
}

export const isEditTool = (name: string) => name === "edit_file" || name === "write_file";
export type ActionKind = "command" | "edit" | "read" | "computer" | "hook" | "other";
export function actionKind(tool: string): ActionKind {
  if (tool === "hook") return "hook";
  if (tool === "run_command") return "command";
  if (isEditTool(tool)) return "edit";
  if (tool === "read_file" || tool === "list_dir" || tool === "search") return "read";
  return tool === "computer" ? "computer" : "other";
}

type Computer = { actions: { type: string; x?: number; y?: number; text?: string; keys?: string[]; name?: string }[] };

/** One readable, secret-free line describing a tool call. */
export function summarizeCall(name: string, args: unknown, computer?: Computer): string {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let text: string;
  if (computer) {
    text = computer.actions.map((x) => (typeof x.x === "number" && typeof x.y === "number" ? `${x.type} ${x.x},${x.y}` : x.type === "type" ? `type "${str(x.text).slice(0, 30)}"` : x.type === "keypress" ? (x.keys ?? []).join("+") : x.type === "open_app" ? `open_app "${str(x.name).slice(0, 40)}"` : x.type)).join(" · ");
  } else if (name === "run_command") text = str(a.command);
  else if (name === "search") text = [str(a.pattern), str(a.glob)].filter(Boolean).join(" · ");
  else if (name === "list_dir") text = str(a.path) || ".";
  else text = str(a.path) || str(a.command) || str(a.pattern) || (Object.keys(a).length ? JSON.stringify(a) : "");
  return clip(oneLine(redactSecrets(text)), MAX_SUMMARY);
}

const optText = (v: unknown, max: number) => (typeof v === "string" && v ? clip(v, max) : undefined);

function normalizeUndo(raw: unknown): UndoRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.root !== "string" || typeof u.path !== "string" || !isBlobId(u.after)) return undefined;
  if (u.before !== null && !isBlobId(u.before)) return undefined;
  const reviewId = typeof u.reviewId === "string" && /^\d+-\d+$/.test(u.reviewId) ? u.reviewId : undefined;
  return { root: u.root, path: u.path, before: u.before as string | null, after: u.after, ...(reviewId ? { reviewId } : {}), ...(typeof u.undone === "number" ? { undone: u.undone } : {}) };
}

/** Accepts whatever was persisted and returns valid entries, oldest first. A call that was "running" belongs to a run that never finished. */
export function normalizeActionLog(raw: unknown): ActionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ActionEntry[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id || ids.has(e.id) || typeof e.at !== "number" || !Number.isFinite(e.at) || typeof e.tool !== "string" || typeof e.status !== "string" || !STATUSES.includes(e.status)) continue;
    ids.add(e.id);
    const undo = normalizeUndo(e.undo);
    out.push({
      id: e.id,
      at: e.at,
      tool: clip(e.tool, 60),
      summary: clip(typeof e.summary === "string" ? e.summary : "", MAX_SUMMARY),
      status: e.status === "running" ? "interrupted" : (e.status as ActionStatus),
      ...(typeof e.durationMs === "number" && Number.isFinite(e.durationMs) ? { durationMs: e.durationMs } : {}),
      ...(optText(e.root, 1000) ? { root: optText(e.root, 1000) } : {}),
      ...(optText(e.project, 1000) ? { project: optText(e.project, 1000) } : {}),
      ...(typeof e.approval === "string" && APPROVALS.includes(e.approval) ? { approval: e.approval as Approval } : {}),
      ...(optText(e.rule, 400) ? { rule: optText(e.rule, 400) } : {}),
      ...(e.builtin === true ? { builtin: true } : {}),
      ...(e.source === "scheduled" || e.source === "hook" ? { source: e.source } : {}),
      ...(e.source === "hook" && normalizeHook(e.hook) ? { hook: normalizeHook(e.hook) } : {}),
      ...(optText(e.detail, MAX_DETAIL) ? { detail: optText(e.detail, MAX_DETAIL) } : {}),
      ...(undo ? { undo } : {}),
    });
  }
  return out.slice(-MAX_ENTRIES);
}

export const appendEntry = (list: readonly ActionEntry[], entry: ActionEntry): ActionEntry[] => [...list, entry].slice(-MAX_ENTRIES);
export const patchEntry = (list: readonly ActionEntry[], id: string, patch: Partial<ActionEntry>): ActionEntry[] => list.map((e) => (e.id === id ? { ...e, ...patch } : e));

/** Merges the stored log with entries recorded before it finished loading. */
export function mergeLogs(stored: readonly ActionEntry[], recent: readonly ActionEntry[]): ActionEntry[] {
  const ids = new Set(recent.map((e) => e.id));
  return [...stored.filter((e) => !ids.has(e.id)), ...recent].slice(-MAX_ENTRIES);
}

export const clipDetail = (s: string) => clip(oneLine(redactSecrets(s)).trim(), MAX_DETAIL);

export type UndoBlock = "none" | "undone" | "running" | "later";
/**
 * Why an entry cannot be undone right now, or null when it can be tried. `running`: the agent still works in that
 * folder. `later`: a newer edit of the same file has to be undone first (edits are undone newest first).
 */
export function undoBlocker(entries: readonly ActionEntry[], entry: ActionEntry, active: ReadonlySet<string>): UndoBlock | null {
  const u = entry.undo;
  if (!u) return "none";
  if (u.undone) return "undone";
  if (active.has(u.root)) return "running";
  const i = entries.findIndex((e) => e.id === entry.id);
  return i >= 0 && entries.slice(i + 1).some((e) => e.undo && !e.undo.undone && e.undo.root === u.root && e.undo.path === u.path) ? "later" : null;
}
