import * as SecureStore from "expo-secure-store";

/** A desktop this phone is paired with. The device token is NOT stored here; it lives under its own Keychain/Keystore key. */
export interface PairedDesktop {
  id: string;
  name: string;
  host: string;
  port: number;
  /** Pinned certificate fingerprint (lowercase hex). */
  fingerprint: string;
  pairedAt: number;
}

export type ThemeMode = "system" | "light" | "dark";
export type Locale = "en" | "ru";
export interface Prefs {
  theme: ThemeMode;
  locale: Locale | "system";
}

const DESKTOPS_KEY = "gustaf.desktops";
const PREFS_KEY = "gustaf.prefs";
const tokenKey = (deviceId: string) => `gustaf.token.${deviceId.replace(/[^A-Za-z0-9._-]/g, "_")}`;

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await SecureStore.getItemAsync(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const loadDesktops = () => readJson<PairedDesktop[]>(DESKTOPS_KEY, []);
export const saveDesktops = (list: PairedDesktop[]) => SecureStore.setItemAsync(DESKTOPS_KEY, JSON.stringify(list));

export const loadPrefs = () => readJson<Prefs>(PREFS_KEY, { theme: "system", locale: "system" });
export const savePrefs = (p: Prefs) => SecureStore.setItemAsync(PREFS_KEY, JSON.stringify(p));

export const loadToken = (deviceId: string) => SecureStore.getItemAsync(tokenKey(deviceId));
export const saveToken = (deviceId: string, token: string) => SecureStore.setItemAsync(tokenKey(deviceId), token);
export const deleteToken = (deviceId: string) => SecureStore.deleteItemAsync(tokenKey(deviceId));
