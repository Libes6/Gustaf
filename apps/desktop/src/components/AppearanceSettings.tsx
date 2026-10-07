import { useEffect, useState } from "react";
import { useT, type Key } from "../i18n";
import { getThemePrefs, setThemePrefs, subscribeTheme } from "../lib/theme";
import { SettingRow, SettingsSection } from "./SettingRow";
import { getAppearance, resetAppearance, setAppearance, subscribeAppearance } from "../lib/appearance";
import {
  CODE_SIZE_MAX, CODE_SIZE_MIN, FONT_PRESETS, isDefaultAppearance, MOTION_SPEEDS, sanitizeFontName, UI_SIZE_MAX, UI_SIZE_MIN,
  type AppearancePrefs, type FontChoice, type FontPreset, type MotionSpeed,
} from "../lib/appearanceUtil";
import { ACCENT_PRESETS, CHAT_WIDTHS, normalizeHex, THEME_MODES, type ChatWidth, type ThemeMode } from "../lib/themeUtil";

const MODE_LABEL: Record<ThemeMode, Key> = { system: "themeSystem", light: "themeLight", dark: "themeDark" };
const WIDTH_LABEL: Record<ChatWidth, Key> = { standard: "chatWidthStandard", wide: "chatWidthWide", full: "chatWidthFull" };

const FONT_LABEL: Record<FontPreset, Key> = { default: "fontDefault", sans: "fontSans", serif: "fontSerif", mono: "fontMono", custom: "fontCustom" };
const MOTION_LABEL: Record<MotionSpeed, Key> = { off: "motionOff", fast: "motionFast", normal: "motionNormal", slow: "motionSlow" };

function FontPicker({ label, value, onChange }: { label: string; value: FontChoice; onChange: (v: FontChoice) => void }) {
  const t = useT();
  const [draft, setDraft] = useState(value.custom);
  const ok = draft === "" || sanitizeFontName(draft) !== null;
  return (
    <div className="appearance-font">
      <select aria-label={label} value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value as FontPreset })}>
        {FONT_PRESETS.map((p) => <option key={p} value={p}>{t(FONT_LABEL[p])}</option>)}
      </select>
      {value.preset === "custom" && (
        <input
          type="text"
          value={draft}
          placeholder={t("fontCustomName")}
          aria-label={`${label}: ${t("fontCustomName")}`}
          aria-invalid={!ok}
          title={ok ? undefined : t("fontInvalid")}
          style={ok ? undefined : { borderColor: "var(--red)" }}
          onChange={(e) => {
            setDraft(e.target.value);
            const name = sanitizeFontName(e.target.value);
            if (name) onChange({ preset: "custom", custom: name });
          }}
        />
      )}
    </div>
  );
}

function SizeInput({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      aria-label={label}
      min={min}
      max={max}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && Number.isInteger(n) && n >= min && n <= max) onChange(n);
      }}
      onBlur={() => setDraft(String(value))}
      style={{ width: 70, background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 8px" }}
    />
  );
}

/** Sample text, code and diff drawn with the real app classes, so every appearance setting is visible at once. */
export function AppearancePreview() {
  const t = useT();
  return (
    <aside className="appearance-preview" aria-label={t("appearancePreview")} data-testid="appearance-preview">
      <h5>{t("appearancePreview")}</h5>
      <div className="md"><p>{t("appearanceSampleText")}</p></div>
      <div className="codeblock"><pre data-testid="preview-code">{"function greet(name: string) {\n  return `Hello, ${name}! This is a deliberately long line to show how wrapping behaves in code.`;\n}"}</pre></div>
      <pre className="diff" data-testid="preview-diff">
        <div className="hunk">@@ -1,2 +1,2 @@</div>
        <div className="del">{"- const title = \"Old title that is long enough to need wrapping in a narrow panel\";"}</div>
        <div className="add">{"+ const title = \"New title that is long enough to need wrapping in a narrow panel\";"}</div>
      </pre>
    </aside>
  );
}

/** Theme (light / dark / system) and accent color; stored in app settings through lib/theme.ts. */
export function AppearanceSettings() {
  const t = useT();
  const [prefs, setPrefs] = useState(getThemePrefs);
  const [custom, setCustom] = useState("");
  const [ap, setAp] = useState<AppearancePrefs>(getAppearance);
  useEffect(() => subscribeTheme(setPrefs), []);
  useEffect(() => subscribeAppearance(setAp), []);
  const customOk = custom === "" || normalizeHex(custom) !== null;
  const isPreset = ACCENT_PRESETS.includes(prefs.accent);
  return (
    <div className="appearance-layout">
    <div>
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
        <SettingRow id="uiFont" title={t("uiFont")}>
          <FontPicker label={t("uiFont")} value={ap.uiFont} onChange={(uiFont) => setAppearance({ uiFont })} />
        </SettingRow>
        <SettingRow id="uiSize" title={t("uiSize")} description={t("sizePx")}>
          <SizeInput label={t("uiSize")} value={ap.uiSize} min={UI_SIZE_MIN} max={UI_SIZE_MAX} onChange={(uiSize) => setAppearance({ uiSize })} />
        </SettingRow>
        <SettingRow id="codeFont" title={t("codeFont")}>
          <FontPicker label={t("codeFont")} value={ap.codeFont} onChange={(codeFont) => setAppearance({ codeFont })} />
        </SettingRow>
        <SettingRow id="codeSize" title={t("codeSize")} description={t("sizePx")}>
          <SizeInput label={t("codeSize")} value={ap.codeSize} min={CODE_SIZE_MIN} max={CODE_SIZE_MAX} onChange={(codeSize) => setAppearance({ codeSize })} />
        </SettingRow>
        <SettingRow id="wrapCode" title={t("wrapCode")} description={t("wrapCodeHint")} toggle={{ on: ap.wrapCode, onChange: (wrapCode) => setAppearance({ wrapCode }) }} />
        <SettingRow id="motionSpeed" title={t("motionSpeed")} description={t("motionSpeedHint")}>
          <div className="seg" role="group" aria-label={t("motionSpeed")}>
            {MOTION_SPEEDS.map((m) => (
              <button key={m} className={ap.motion === m ? "active" : ""} aria-pressed={ap.motion === m} onClick={() => setAppearance({ motion: m })}>{t(MOTION_LABEL[m])}</button>
            ))}
          </div>
        </SettingRow>
        <SettingRow id="appearanceReset" title={t("appearanceReset")} description={t("appearanceResetHint")}>
          <button className="btn-soft" disabled={isDefaultAppearance(ap)} onClick={resetAppearance}>{t("appearanceResetAction")}</button>
        </SettingRow>
    </SettingsSection>
    </div>
    <AppearancePreview />
    </div>
  );
}
