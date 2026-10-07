import { useEffect, useState } from "react";
import { useT, type Key } from "../i18n";
import { getThemePrefs, setThemePrefs, subscribeTheme } from "../lib/theme";
import { SettingRow, SettingsSection } from "./SettingRow";
import { ACCENT_PRESETS, CHAT_WIDTHS, normalizeHex, THEME_MODES, type ChatWidth, type ThemeMode } from "../lib/themeUtil";

const MODE_LABEL: Record<ThemeMode, Key> = { system: "themeSystem", light: "themeLight", dark: "themeDark" };
const WIDTH_LABEL: Record<ChatWidth, Key> = { standard: "chatWidthStandard", wide: "chatWidthWide", full: "chatWidthFull" };

/** Theme (light / dark / system) and accent color; stored in app settings through lib/theme.ts. */
export function AppearanceSettings() {
  const t = useT();
  const [prefs, setPrefs] = useState(getThemePrefs);
  const [custom, setCustom] = useState("");
  useEffect(() => subscribeTheme(setPrefs), []);
  const customOk = custom === "" || normalizeHex(custom) !== null;
  const isPreset = ACCENT_PRESETS.includes(prefs.accent);
  return (
    <SettingsSection title={t("appearance")}>
        <SettingRow id="theme" title={t("themeLabel")}>
          <div className="seg" role="group" aria-label={t("themeLabel")}>
            {THEME_MODES.map((m) => (
              <button key={m} className={prefs.mode === m ? "active" : ""} aria-pressed={prefs.mode === m} onClick={() => setThemePrefs({ mode: m })}>{t(MODE_LABEL[m])}</button>
            ))}
          </div>
        </SettingRow>
        <SettingRow id="chatWidth" title={t("chatWidth")} description={t("chatWidthHint")}>
          <div className="seg" role="group" aria-label={t("chatWidth")}>
            {CHAT_WIDTHS.map((w) => (
              <button key={w} className={prefs.width === w ? "active" : ""} aria-pressed={prefs.width === w} onClick={() => setThemePrefs({ width: w })}>{t(WIDTH_LABEL[w])}</button>
            ))}
          </div>
        </SettingRow>
        <SettingRow id="accent" title={t("accentColor")}>
          <>
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                aria-label={c}
                aria-pressed={prefs.accent === c}
                onClick={() => { setCustom(""); setThemePrefs({ accent: c }); }}
                style={{ width: 24, height: 24, borderRadius: "50%", background: c, outline: prefs.accent === c ? "2px solid var(--text)" : undefined, outlineOffset: 2 }}
              />
            ))}
            <input
              value={custom}
              placeholder={isPreset ? t("accentCustom") : prefs.accent}
              aria-label={t("accentCustom")}
              aria-invalid={!customOk}
              title={customOk ? undefined : t("accentInvalid")}
              onChange={(e) => {
                setCustom(e.target.value);
                const hex = normalizeHex(e.target.value);
                if (hex) setThemePrefs({ accent: hex });
              }}
              style={{ width: 150, background: "var(--bg-input)", border: `1px solid ${customOk ? "var(--border)" : "var(--red)"}`, borderRadius: 8, padding: "4px 8px", userSelect: "text" }}
            />
          </>
        </SettingRow>
    </SettingsSection>
  );
}
