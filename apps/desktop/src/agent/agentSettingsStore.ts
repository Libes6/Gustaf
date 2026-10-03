import { useEffect, useSyncExternalStore } from "react";
import { getSetting, setSetting } from "../lib/api";
import { AGENT_SETTINGS, DEFAULT_AGENT_SETTINGS, normalizeAgentSettings, type AgentSettings } from "./agentSettings";

// Shared agent settings (like the budgets store): loaded once from the `settings` table, saved on every change.
let current: AgentSettings = DEFAULT_AGENT_SETTINGS;
let loading: Promise<AgentSettings> | undefined;
let edited = false;
const listeners = new Set<() => void>();
const publish = (next: AgentSettings) => {
  current = next;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Resolves to the stored settings (defaults when missing or unreadable). */
export function loadAgentSettings(): Promise<AgentSettings> {
  loading ??= getSetting<unknown>(AGENT_SETTINGS, null)
    .then((v) => {
      if (!edited) publish(normalizeAgentSettings(v));
      return current;
    })
    .catch(() => {
      loading = undefined;
      return current;
    });
  return loading;
}

export const getAgentSettings = () => current;

export function saveAgentSettings(next: AgentSettings) {
  edited = true;
  const clean = normalizeAgentSettings(next);
  publish(clean);
  setSetting(AGENT_SETTINGS, clean).catch(() => {});
}

export function useAgentSettings(): AgentSettings {
  useEffect(() => void loadAgentSettings(), []);
  return useSyncExternalStore(subscribe, () => current);
}

/** Test helper: forget the in-memory copy. */
export function resetAgentSettings() {
  current = DEFAULT_AGENT_SETTINGS;
  loading = undefined;
  edited = false;
}
