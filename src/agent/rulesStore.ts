import { useEffect, useSyncExternalStore } from "react";
import { fsx, getSetting, setSetting } from "../lib/api";
import { parseReviewRoot, reviewLocation } from "../lib/fileUndo";
import { COMMAND_RULES_SETTING, DEFAULT_RULES, normalizeRulesConfig, type RulesConfig } from "./rules";

// Command rules live in the app `settings` table under "commandRules". One in-memory copy is shared by the settings
// page and the agent, so an edit applies to the very next command, even in a run that is already going.
let current: RulesConfig = DEFAULT_RULES;
let loading: Promise<void> | undefined;
let edited = false;
const listeners = new Set<() => void>();
const publish = (next: RulesConfig) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const load = () => {
  loading ??= getSetting<unknown>(COMMAND_RULES_SETTING, null)
    .then((v) => {
      if (!edited) publish(normalizeRulesConfig(v));
    })
    .catch(() => {
      loading = undefined; // try again next time instead of caching the failure
    });
  return loading;
};

/** The rules in force. Falls back to the defaults (built-in protections on, no user rules) if settings cannot be read. */
export async function getRulesConfig(): Promise<RulesConfig> {
  await load();
  return current;
}

export function saveRulesConfig(next: RulesConfig) {
  edited = true;
  publish(next);
  setSetting(COMMAND_RULES_SETTING, next).catch(() => {});
}

export function useRulesConfig(): RulesConfig {
  useEffect(() => void load(), []);
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * The project folder a run belongs to. Writable projects run in a review copy, whose `review.json` names the project.
 * Returns null when it cannot be told, in which case project-scoped deny/ask rules apply and project allow rules do not.
 */
export async function projectRootFor(root: string, reviewMode: boolean): Promise<string | null> {
  if (!reviewMode) return root;
  const where = reviewLocation(root);
  if (!where) return null;
  try {
    return parseReviewRoot(await fsx.read(where.dir, `${where.id}/review.json`));
  } catch {
    return null;
  }
}
