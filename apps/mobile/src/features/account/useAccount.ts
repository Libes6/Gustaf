import Constants from "expo-constants";
import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import { useSyncExternalStore } from "react";

import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { accountRedirectUri, makeAccountApi, resolveAccountApiUrl } from "./accountApi";
import { type AccountState, createAccountStore } from "./accountStore";

function appScheme(): string {
  const scheme = Constants.expoConfig?.scheme;
  return (Array.isArray(scheme) ? scheme[0] : scheme) ?? "gustaf";
}

const apiUrl = resolveAccountApiUrl();

export const accountStore = createAccountStore({
  api: makeAccountApi(apiUrl, (input, init) => fetch(input, init)),
  apiUrl,
  redirectUri: accountRedirectUri(appScheme()),
  openAuthSession: (url, redirectUri) => WebBrowser.openAuthSessionAsync(url, redirectUri),
  phoneName: () =>
    Constants.deviceName?.trim() ||
    Device.modelName?.trim() ||
    Device.deviceName?.trim() ||
    "Phone",
  whenStorageReady: whenProtectedDataAvailable,
});

export function useAccount(): AccountState {
  return useSyncExternalStore(accountStore.subscribe, accountStore.getState);
}
