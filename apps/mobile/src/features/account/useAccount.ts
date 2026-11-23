import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { accountRedirectUri, makeAccountApi, resolveAccountApiUrl } from "./accountApi";
import { createAccountHeartbeat } from "./accountHeartbeat";
import { loadPhoneDevice } from "./accountStorage";
import { type AccountState, createAccountStore } from "./accountStore";

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "gustaf";
}

const apiUrl = resolveAccountApiUrl();

export const phoneDisplayName = () =>
  Constants.deviceName?.trim() || Device.modelName?.trim() || Device.deviceName?.trim() || "Phone";

const api = makeAccountApi(apiUrl, (input, init) => fetch(input, init));

const sendHeartbeat = createAccountHeartbeat({
  send: api.heartbeat,
  deviceToken: async () => {
    await whenProtectedDataAvailable();
    return (await loadPhoneDevice())?.token ?? null;
  },
  report: () => {
    const appVersion = Application.nativeApplicationVersion;
    if (!appVersion || (Platform.OS !== "android" && Platform.OS !== "ios")) return null;
    return { appVersion, platform: Platform.OS, osVersion: Device.osVersion ?? null };
  },
  now: Date.now,
  onError: (cause) => console.warn("[account] heartbeat failed", cause),
});

/** Reports the app version on launch and, at most once a day, when the app returns. */
export function installAccountHeartbeat(): () => void {
  void sendHeartbeat();
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") void sendHeartbeat();
  });
  return () => subscription.remove();
}

export const accountStore = createAccountStore({
  api,
  apiUrl,
  redirectUri: accountRedirectUri(appScheme()),
  openAuthSession: (url, redirectUri) => WebBrowser.openAuthSessionAsync(url, redirectUri),
  phoneName: phoneDisplayName,
  whenStorageReady: whenProtectedDataAvailable,
  onPhoneRegistered: () => void sendHeartbeat({ force: true }),
});

export function useAccount(): AccountState {
  return useSyncExternalStore(accountStore.subscribe, accountStore.getState);
}
