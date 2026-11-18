import { translate, translateSettingsGroup, translateSettingsNav, type MessageKey } from "./i18n";
import { useUiLanguage } from "./uiLanguageStore";

// Keep this module free of app imports. See uiLanguageStore.ts.

const englishT = (key: MessageKey) => translate("en", key);
const russianT = (key: MessageKey) => translate("ru", key);

export function useT() {
  const language = useUiLanguage();
  return language === "ru" ? russianT : englishT;
}

export function useSettingsNavLabel() {
  const language = useUiLanguage();
  return (path: string, fallback: string) => translateSettingsNav(language, path, fallback);
}

export function useSettingsGroupLabel() {
  const language = useUiLanguage();
  return (heading: string) => translateSettingsGroup(language, heading);
}
