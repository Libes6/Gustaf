import {
  type ClientConfigSnapshot,
  createClientConfigStore,
  EMPTY_CLIENT_CONFIG,
} from "@t3tools/client-runtime/client-config";
import { useSyncExternalStore } from "react";

// Only the Gustaf desktop shell asks the cloud: it knows the installed version and holds the
// account credential. Browsers keep the empty config, so every flag reads as off.
const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
const account = bridge?.gustafAccount;

export const clientConfigStore = account?.clientConfig
  ? createClientConfigStore({
      version: bridge?.getAppVersion?.() ?? import.meta.env.APP_VERSION ?? "0.0.0",
      fetchConfig: () => account.clientConfig(),
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
