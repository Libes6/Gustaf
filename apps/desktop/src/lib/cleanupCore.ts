// Automatic storage cleanup (T13): which workspace checkouts can go. Only the checkout folder is removed, never the
// branch, so no commit is lost; a checkout with uncommitted changes is never a candidate. Pure: Node runs this file.
import type { WorktreeInfo } from "./worktrees";

export type CleanupConfig = { enabled: boolean; days: number };
export const DEFAULT_CLEANUP: CleanupConfig = { enabled: false, days: 14 };
export const CLEANUP_DAYS = [7, 14, 30, 60] as const;
export const DAY_MS = 86_400_000;

export function parseCleanup(v: unknown): CleanupConfig {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const days = typeof o.days === "number" && Number.isFinite(o.days) ? Math.min(365, Math.max(1, Math.round(o.days))) : DEFAULT_CLEANUP.days;
  return { enabled: o.enabled === true, days };
}

export type CleanupChat = { id: number; updated_at: number; workspace_task_id?: string | null };
export type CleanupTarget = { chatId: number; taskId: string };

/** Workspace chats untouched for `days` whose checkout still exists and has nothing uncommitted. */
export function staleWorkspaces(chats: readonly CleanupChat[], infos: readonly WorktreeInfo[], now: number, days: number): CleanupTarget[] {
  const byTask = new Map(infos.map((i) => [i.taskId, i]));
  const out: CleanupTarget[] = [];
  for (const c of chats) {
    const taskId = c.workspace_task_id;
    if (!taskId) continue;
    const info = byTask.get(taskId);
    if (!info || !info.existsOnDisk || info.dirty) continue;
    if (now - Math.max(c.updated_at, info.createdAt * 1000) < days * DAY_MS) continue;
    out.push({ chatId: c.id, taskId });
  }
  return out;
}

/** Runs at most once a day. */
export const cleanupDue = (lastRun: number, now: number) => !(lastRun > 0) || now - lastRun >= DAY_MS || lastRun > now;
