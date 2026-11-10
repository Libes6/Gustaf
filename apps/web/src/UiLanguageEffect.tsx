import { useLayoutEffect } from "react";

import { useClientSettings } from "./hooks/useSettings";
import { setUiLanguage } from "./uiLanguageStore";

/** Copies the saved interface language into the store that useT reads. */
export function UiLanguageEffect() {
  const language = useClientSettings((settings) => settings.uiLanguage);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the language store and <html lang> follow the saved setting; a layout effect applies it before the first paint
  useLayoutEffect(() => {
    setUiLanguage(language);
    document.documentElement.lang = language;
  }, [language]);
  return null;
}
