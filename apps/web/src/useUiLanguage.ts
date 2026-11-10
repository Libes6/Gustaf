import { useEffect } from "react";

import { useClientSettings } from "./hooks/useSettings";
import {
  settingCopy,
  translate,
  translateSettingsGroup,
  translateSettingsNav,
  type MessageKey,
} from "./i18n";
import { searchableSetting, type SettingsSearchItemId } from "./components/settings/settingsSearch";

function useUiLanguage() {
  return useClientSettings((settings) => settings.uiLanguage);
}

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

export function useLocalizedSettingLookup() {
  const language = useUiLanguage();
  return (id: SettingsSearchItemId) => {
    const base = searchableSetting(id);
    const copy = settingCopy(language, id);
    if (copy) {
      return { id: base.id, title: copy.title, description: copy.description };
    }
    return {
      id: base.id,
      title: base.title,
      description: "description" in base ? String(base.description ?? "") : "",
    };
  };
}

export function UiLanguageEffect() {
  const language = useUiLanguage();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps <html lang> in step with the saved interface language
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  return null;
}
