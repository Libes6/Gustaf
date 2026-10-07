// Automatic storage cleanup (lib/cleanupCore.ts): once a day, while the app runs and the setting is on, the checkout of
// every workspace chat idle for N days (and without uncommitted changes) is removed like "Archive" does. Branches stay.
import { db, getSetting, rawLog, setSetting } from "./api";
import { listProjects } from "./data";
import {
  cleanupDue,
  logDay,
  parseCleanup,
  planWorkspaces,
  type CleanupChat,
  type CleanupConfig,
  type CleanupPreview,
  type CleanupTarget,
} from "./cleanupCore";
import { refreshWorkspaces } from "./workspaceStore";
import { worktrees } from "./worktrees";

const CHECK_MS = 60 * 60 * 1000;

export const loadCleanup = async (): Promise<CleanupConfig> =>
  parseCleanup(await getSetting<unknown>("storageCleanup", null).catch(() => null));
export const saveCleanup = (c: CleanupConfig) => setSetting("storageCleanup", c);

type Planned = CleanupTarget & { root: string };

/** What the workspace policy would remove (and which idle ones it protects because of uncommitted changes), without touching anything. */
export async function planWorkspaceCleanup(
  days: number,
  now = Date.now(),
): Promise<{ remove: Planned[]; keptDirty: number }> {
  const out = { remove: [] as Planned[], keptDirty: 0 };
  for (const p of await listProjects()) {
    if (!p.path) continue;
    const infos = await worktrees.list(p.path).catch(() => null);
    if (!infos) continue;
    const chats = await db.select<CleanupChat>(
      "select id, updated_at, workspace_task_id from chats where project_id = ? and workspace_task_id is not null",
      [p.id],
    );
    const plan = planWorkspaces(chats, infos, now, days);
    out.remove.push(...plan.remove.map((t) => ({ ...t, root: p.path as string })));
    out.keptDirty += plan.keptDirty.length;
  }
  return out;
}

/** Removes the stale checkouts of every project; returns how many went. Never forces and never deletes the branch or the chat. */
export async function runCleanup(days: number, now = Date.now()): Promise<number> {
  let removed = 0;
  const roots = new Set<string>();
  for (const t of (await planWorkspaceCleanup(days, now)).remove) {
    try {
      await worktrees.remove({ root: t.root, taskId: t.taskId });
      removed++;
      roots.add(t.root);
    } catch {
      /* dirty or already gone: leave it */
    }
  }
  for (const r of roots) await refreshWorkspaces(r, { force: true });
  return removed;
}

/** Raw CLI log day files older than `days` (today's file is never included). `dryRun` only lists them. */
export const cleanupLogs = (days: number, dryRun: boolean, now = Date.now()) => rawLog.prune(logDay(now), days, dryRun);

/** Everything both policies would delete right now, for the preview. */
export async function previewCleanup(cfg: CleanupConfig, now = Date.now()): Promise<CleanupPreview> {
  const w = await planWorkspaceCleanup(cfg.days, now);
  const l = await cleanupLogs(cfg.logsDays, true, now).catch(() => ({ files: [] as string[], bytes: 0 }));
  return { workspaces: w.remove, keptDirty: w.keptDirty, logFiles: l.files, logBytes: l.bytes };
}

/** Called once from App; returns the stop function. */
export function startCleanupScheduler(): () => void {
  const tick = async () => {
    try {
      const cfg = await loadCleanup();
      if (!cfg.enabled && !cfg.logsEnabled) return;
      const now = Date.now();
      if (!cleanupDue(await getSetting<number>("storageCleanupLast", 0), now)) return;
      await setSetting("storageCleanupLast", now);
      if (cfg.enabled) await runCleanup(cfg.days, now);
      if (cfg.logsEnabled) await cleanupLogs(cfg.logsDays, false, now).catch(() => {});
    } catch {
      /* try again next hour */
    }
  };
  const first = setTimeout(() => void tick(), 90_000);
  const timer = setInterval(() => void tick(), CHECK_MS);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
