import { createContext, useContext, useEffect, type ReactNode } from "react";
import en from "./en.json";
import ru from "./ru.json";

export type Locale = "ru" | "en";
export type Key = keyof typeof en;
const dicts: Record<Locale, Record<string, string>> = { en, ru };

/** English is the default on a clean profile; a saved choice (setting `locale`) overrides it. */
export const detectLocale = (): Locale => "en";

/**
 * `{name}` placeholders; plural keys use `_one`/`_few`/`_many`/`_other` suffixes picked by Intl.PluralRules on `{count}`.
 */
export function translate(locale: Locale, key: Key, vars: Record<string, string | number> = {}) {
  const d = dicts[locale];
  let s = d[key];
  if ("count" in vars) {
    const form = new Intl.PluralRules(locale).select(Number(vars.count));
    s = d[`${key}_${form}`] ?? d[`${key}_other`] ?? s;
  }
  s ??= dicts.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));
}

const Ctx = createContext<Locale>("en");

export const I18nProvider = ({ locale, children }: { locale: Locale; children: ReactNode }) => {
  // Screen readers pick the voice and pronunciation from <html lang>.
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <Ctx.Provider value={locale}>{children}</Ctx.Provider>;
};

export function useT() {
  const locale = useContext(Ctx);
  const t = (key: Key, vars?: Record<string, string | number>) => translate(locale, key, vars);
  t.locale = locale;
  t.date = (ms: number) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms);
  t.num = (n: number) => new Intl.NumberFormat(locale).format(n);
  return t;
}
