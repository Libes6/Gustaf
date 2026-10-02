import { useEffect, useState } from "react";
import { useT, type Key } from "../i18n";
import { getThemePrefs, setThemePrefs, subscribeTheme } from "../lib/theme";
import { ACCENT_PRESETS, normalizeHex, THEME_MODES, type ThemeMode } from "../lib/themeUtil";

const MODE_LABEL: Record<ThemeMode, Key> = { system: "themeSystem", light: "themeLight", dark: "themeDark" };

/** Theme (light / dark / system) and accent color; stored in app settings through lib/theme.ts. */
export function AppearanceSettings() {
  const t = useT();
  const [prefs, setPrefs] = useState(getThemePrefs);
  const [custom, setCustom] = useState("");
  useEffect(() => subscribeTheme(setPrefs), []);
  const customOk = custom === "" || normalizeHex(custom) !== null;
  const isPreset = ACCENT_PRESETS.includes(prefs.accent);
  return (
    <>
      <h4>{t("appearance")}</h4>
      <div className="card">
        <div className="card-row">
          <div className="grow"><div className="t">{t("themeLabel")}</div></div>
          <div className="seg" style={{ margin: 0 }}>
            {THEME_MODES.map((m) => (
              <button key={m} className={prefs.mode === m ? "active" : ""} onClick={() => setThemePrefs({ mode: m })}>{t(MODE_LABEL[m])}</button>
            ))}
          </div>
        </div>
        <div className="card-row">
          <div className="grow"><div className="t">{t("accentColor")}</div></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                aria-label={c}
                aria-pressed={prefs.accent === c}
                onClick={() => { setCustom(""); setThemePrefs({ accent: c }); }}
                style={{ width: 20, height: 20, borderRadius: "50%", background: c, outline: prefs.accent === c ? "2px solid var(--text)" : "none", outlineOffset: 2 }}
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
          </div>
        </div>
      </div>
    </>
  );
}
