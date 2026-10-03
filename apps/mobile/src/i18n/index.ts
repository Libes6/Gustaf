import { getLocales } from "expo-localization";
import { useStore } from "../state/store.ts";
import { en, type StringKey } from "./en.ts";
import { ru } from "./ru.ts";

export type { StringKey };
export type Lang = "en" | "ru";

const tables: Record<Lang, Record<StringKey, string>> = { en, ru };

export function systemLang(): Lang {
  return getLocales()[0]?.languageCode === "ru" ? "ru" : "en";
}

/** Pure translation with `{name}` placeholders; falls back to English, then to the key. */
export function translate(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  const raw = tables[lang][key] ?? en[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
}

export function useT() {
  const pref = useStore((s) => s.prefs.locale);
  const lang: Lang = pref === "system" ? systemLang() : pref;
  return (key: StringKey, vars?: Record<string, string | number>) => translate(lang, key, vars);
}
