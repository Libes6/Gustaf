import { useEffect, useState } from "react";
import { getSetting, setSetting } from "../lib/api";
import { loadProviders } from "./index";
import { EMPTY_POOL, migrateBackups, normalizePool, type CursorPool } from "./cursorAccounts";
import type { ProviderConfig } from "./types";

const KEY = "cursorPool";
const CHANGED = "gustaf-cursor-pool";

/** Reads the pool, migrating the legacy `backupProviderId` into it on first sight (providers are rewritten
 *  without the field) and dropping accounts that no longer exist. */
export async function loadPool(): Promise<{ pool: CursorPool; providers: ProviderConfig[] }> {
  let providers = await loadProviders();
  const stored = normalizePool(await getSetting<unknown>(KEY, EMPTY_POOL), providers);
  const migrated = migrateBackups(providers, stored);
  if (migrated.changed) {
    providers = migrated.providers;
    await setSetting("providers", providers);
    await setSetting(KEY, migrated.pool);
  }
  return { pool: migrated.pool, providers };
}

let queue: Promise<unknown> = Promise.resolve();

/** Serialized read-modify-write, so two quick updates (a failure and a click) never lose one another. */
export function updatePool(fn: (pool: CursorPool, providers: ProviderConfig[]) => CursorPool): Promise<CursorPool> {
  const run = queue.then(async () => {
    const { pool, providers } = await loadPool();
    const next = normalizePool(fn(pool, providers), providers);
    await setSetting(KEY, next);
    dispatchEvent(new Event(CHANGED));
    return next;
  });
  queue = run.catch(() => {});
  return run;
}

/** The current pool, refreshed whenever it changes anywhere in the app. */
export function useCursorPool() {
  const [state, setState] = useState<{ pool: CursorPool; providers: ProviderConfig[] } | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => loadPool().then(s => alive && setState(s), () => {});
    refresh();
    addEventListener(CHANGED, refresh);
    return () => { alive = false; removeEventListener(CHANGED, refresh); };
  }, []);
  return state?.pool ?? EMPTY_POOL;
}
