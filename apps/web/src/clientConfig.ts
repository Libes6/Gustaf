import {
  type ClientConfigSnapshot,
  createClientConfigStore,
  EMPTY_CLIENT_CONFIG,
  isFeatureEnabled,
} from "@t3tools/client-runtime/client-config";
import { useSyncExternalStore } from "react";

// Only the Gustaf shell asks the cloud: it knows the installed version and holds the account
// credential. Browsers and older shells keep the empty config, so every flag reads as off.
const shell = typeof window === "undefined" ? undefined : window.gustafShell;

export const clientConfigStore = shell?.clientConfig
  ? createClientConfigStore({
      version: shell.version,
      fetchConfig: shell.clientConfig,
      storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
      },
    })
  : null;

const EMPTY_SNAPSHOT: ClientConfigSnapshot = { config: EMPTY_CLIENT_CONFIG, announcements: [] };
const noSubscription = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

export function useClientConfig(): ClientConfigSnapshot {
  return useSyncExternalStore(
    clientConfigStore?.subscribe ?? noSubscription,
    clientConfigStore?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
}

/** Whether the cloud turned `key` on for this user; off when unknown or offline. */
export function useFeatureFlag(key: string): boolean {
  return isFeatureEnabled(useClientConfig().config, key);
}
