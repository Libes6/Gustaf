// Automatic storage cleanup (lib/cleanupCore.ts): once a day, while the app runs and the setting is on, the checkout of
// every workspace chat idle for N days (and without uncommitted changes) is removed like "Archive" does. Branches stay.
import { db, getSetting, setSetting } from "./api";
import { listProjects } from "./data";
import { cleanupDue, parseCleanup, staleWorkspaces, type CleanupChat, type CleanupConfig } from "./cleanupCore";
import { refreshWorkspaces } from "./workspaceStore";
import { worktrees } from "./worktrees";

const CHECK_MS = 60 * 60 * 1000;

export const loadCleanup = async (): Promise<CleanupConfig> => parseCleanup(await getSetting<unknown>("storageCleanup", null).catch(() => null));
export const saveCleanup = (c: CleanupConfig) => setSetting("storageCleanup", c);

/** Removes the stale checkouts of every project; returns how many went. Never forces, so a dirty checkout stays. */
export async function runCleanup(days: number, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const p of await listProjects()) {
    if (!p.path) continue;
    const infos = await worktrees.list(p.path).catch(() => null);
    if (!infos) continue;
    const chats = await db.select<CleanupChat>("select id, updated_at, workspace_task_id from chats where project_id = ? and workspace_task_id is not null", [p.id]);
    for (const t of staleWorkspaces(chats, infos, now, days)) {
      try { await worktrees.remove({ root: p.path, taskId: t.taskId }); removed++; } catch { /* dirty or already gone: leave it */ }
    }
    if (removed) await refreshWorkspaces(p.path, { force: true });
  }
  return removed;
}

/** Called once from App; returns the stop function. */
export function startCleanupScheduler(): () => void {
  const tick = async () => {
    try {
      const cfg = await loadCleanup();
      if (!cfg.enabled) return;
      const now = Date.now();
      if (!cleanupDue(await getSetting<number>("storageCleanupLast", 0), now)) return;
      await setSetting("storageCleanupLast", now);
      await runCleanup(cfg.days, now);
    } catch { /* try again next hour */ }
  };
  const first = setTimeout(() => void tick(), 90_000);
  const timer = setInterval(() => void tick(), CHECK_MS);
  return () => { clearTimeout(first); clearInterval(timer); };
}
