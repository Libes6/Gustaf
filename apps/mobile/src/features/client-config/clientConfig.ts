import {
  type ClientConfigSnapshot,
  createClientConfigStore,
  isFeatureEnabled,
} from "@t3tools/client-runtime/client-config";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { useSyncExternalStore } from "react";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { fetchClientConfig, resolveAccountApiUrl } from "../account/accountApi";
import { loadPhoneDevice, loadSession } from "../account/accountStorage";

/** Where a phone below the minimum version gets the current APK. */
export const LATEST_RELEASE_URL = "https://github.com/Libes6/Gustaf/releases/latest";

const appVersion = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? null;

async function credential(): Promise<string | null> {
  try {
    await whenProtectedDataAvailable();
    const [device, session] = await Promise.all([loadPhoneDevice(), loadSession()]);
    return device?.token ?? session?.token ?? null;
  } catch {
    return null;
  }
}

const kvStore = async () => (await import("expo-sqlite/kv-store")).default;

export const clientConfigStore = createClientConfigStore({
  version: appVersion ?? "unknown",
  fetchConfig: async () =>
    fetchClientConfig(resolveAccountApiUrl(), (input, init) => fetch(input, init), {
      version: appVersion,
      platform: Platform.OS,
      token: await credential(),
    }),
  storage: {
    getItem: async (key) => (await kvStore()).getItem(key),
    setItem: async (key, value) => (await kvStore()).setItem(key, value),
  },
});

/** Fetches on start and every few hours; returns the stop function. */
export const installClientConfig = (): (() => void) => clientConfigStore.start();

export function useClientConfig(): ClientConfigSnapshot {
  return useSyncExternalStore(clientConfigStore.subscribe, clientConfigStore.getSnapshot);
}

/** Whether the cloud turned `key` on for this user; off when unknown or offline. */
export function useFeatureFlag(key: string): boolean {
  return isFeatureEnabled(useClientConfig().config, key);
}
