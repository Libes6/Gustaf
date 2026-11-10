import { translate, translateSettingsGroup, translateSettingsNav, type MessageKey } from "./i18n";
import { useUiLanguage } from "./uiLanguageStore";

// Keep this module free of app imports. See uiLanguageStore.ts.

export function useT() {
  const language = useUiLanguage();
  return (key: MessageKey) => translate(language, key);
}

export function useSettingsNavLabel() {
  const language = useUiLanguage();
  return (path: string, fallback: string) => translateSettingsNav(language, path, fallback);
}

export function useSettingsGroupLabel() {
  const language = useUiLanguage();
  return (heading: string) => translateSettingsGroup(language, heading);
}
