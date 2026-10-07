// Automatic storage cleanup (T13): which workspace checkouts can go. Only the checkout folder is removed, never the
// branch, so no commit is lost; a checkout with uncommitted changes is never a candidate. Pure: Node runs this file.
import type { WorktreeInfo } from "./worktrees";

/** Two independent policies: idle workspace checkouts (`enabled`, `days`) and old raw CLI log files (`logsEnabled`, `logsDays`). */
export type CleanupConfig = { enabled: boolean; days: number; logsEnabled: boolean; logsDays: number };
export const DEFAULT_CLEANUP: CleanupConfig = { enabled: false, days: 14, logsEnabled: false, logsDays: 14 };
export const CLEANUP_DAYS = [7, 14, 30, 60] as const;
export const LOG_DAYS = [3, 7, 14, 30] as const;
export const DAY_MS = 86_400_000;

const clampDays = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(365, Math.max(1, Math.round(v))) : fallback);

/** Older saves hold only `enabled` and `days` (the workspace policy); the log policy then starts off. */
export function parseCleanup(v: unknown): CleanupConfig {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    enabled: o.enabled === true,
    days: clampDays(o.days, DEFAULT_CLEANUP.days),
    logsEnabled: o.logsEnabled === true,
    logsDays: clampDays(o.logsDays, DEFAULT_CLEANUP.logsDays),
  };
}

export type CleanupChat = { id: number; updated_at: number; workspace_task_id?: string | null };
export type CleanupTarget = { chatId: number; taskId: string; branch: string; path: string };

/** Idle (for `days`) workspace chats whose checkout still exists, split into the ones that may go and the protected dirty ones. */
export function planWorkspaces(chats: readonly CleanupChat[], infos: readonly WorktreeInfo[], now: number, days: number): { remove: CleanupTarget[]; keptDirty: CleanupTarget[] } {
  const byTask = new Map(infos.map((i) => [i.taskId, i]));
  const plan = { remove: [] as CleanupTarget[], keptDirty: [] as CleanupTarget[] };
  for (const c of chats) {
    const taskId = c.workspace_task_id;
    if (!taskId) continue;
    const info = byTask.get(taskId);
    if (!info || !info.existsOnDisk) continue;
    if (now - Math.max(c.updated_at, info.createdAt * 1000) < days * DAY_MS) continue;
    (info.dirty ? plan.keptDirty : plan.remove).push({ chatId: c.id, taskId, branch: info.branch, path: info.path });
  }
  return plan;
}

/** Workspace chats untouched for `days` whose checkout still exists and has nothing uncommitted. */
export const staleWorkspaces = (chats: readonly CleanupChat[], infos: readonly WorktreeInfo[], now: number, days: number): CleanupTarget[] => planWorkspaces(chats, infos, now, days).remove;

/** Local `YYYY-MM-DD`, the name of a raw log day file (same as lib/rawCliLog.ts). */
export const logDay = (ms: number) => { const d = new Date(ms); const two = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };

export type CleanupPreview = { workspaces: CleanupTarget[]; keptDirty: number; logFiles: string[]; logBytes: number };

/** Runs at most once a day. */
export const cleanupDue = (lastRun: number, now: number) => !(lastRun > 0) || now - lastRun >= DAY_MS || lastRun > now;
