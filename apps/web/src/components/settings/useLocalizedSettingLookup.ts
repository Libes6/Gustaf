import { settingCopy } from "../../i18n";
import { useUiLanguage } from "../../uiLanguageStore";
import { searchableSetting, type SettingsSearchItemId } from "./settingsSearch";

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
