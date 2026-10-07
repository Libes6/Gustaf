import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ask, save } from "@tauri-apps/plugin-dialog";
import { useT, type Key } from "../i18n";
import { fsx } from "../lib/api";
import {
  deleteCustomTheme,
  getCustomThemes,
  saveCustomTheme,
  setActiveCustomTheme,
  subscribeCustomThemes,
} from "../lib/customTheme";
import {
  BASE_PALETTES,
  deriveFromBase,
  duplicateName,
  emptyTheme,
  exportFileName,
  exportTheme,
  MAX_CUSTOM_THEMES,
  MAX_THEME_FILE_BYTES,
  MAX_THEME_NAME,
  parseThemeFile,
  sanitizeThemeName,
  textContrast,
  themeCssVars,
  TOKEN_GROUPS,
  TOKENS,
  uniqueThemeId,
  type CustomTheme,
  type ImportError,
  type TokenGroup,
  type TokenKey,
} from "../lib/customThemeUtil";
import { MIN_TEXT_CONTRAST, normalizeHex, type ResolvedTheme } from "../lib/themeUtil";
import { SettingRow, SettingsSection } from "./SettingRow";

const GROUP_LABEL: Record<TokenGroup, Key> = {
  base: "themeGroupBase",
  surfaces: "themeGroupSurfaces",
  text: "themeGroupText",
  borders: "themeGroupBorders",
  states: "themeGroupStates",
  code: "themeGroupCode",
  diff: "themeGroupDiff",
};
const IMPORT_ERROR: Record<ImportError, Key> = {
  tooLarge: "themeImportTooLarge",
  notJson: "themeImportNotJson",
  notTheme: "themeImportNotTheme",
  version: "themeImportVersion",
  name: "themeImportName",
  unknownKey: "themeImportUnknownKey",
  badColor: "themeImportBadColor",
  noPalette: "themeImportNoPalette",
};

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft((d) => (normalizeHex(d) === value ? d : value)), [value]);
  const ok = normalizeHex(draft) !== null;
  return (
    <div className="theme-color-field">
      <input type="color" aria-label={`${label} (picker)`} value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="mono theme-color-label">{label}</span>
      <input
        type="text"
        aria-label={label}
        aria-invalid={!ok}
        value={draft}
        spellCheck={false}
        maxLength={9}
        onChange={(e) => {
          setDraft(e.target.value);
          if (/^#?[0-9a-f]{6}$/i.test(e.target.value.trim())) onChange(normalizeHex(e.target.value) as string);
        }}
        onBlur={() => {
          const hex = normalizeHex(draft);
          if (hex) onChange(hex);
          setDraft(hex ?? value);
        }}
        style={ok ? undefined : { borderColor: "var(--red)" }}
      />
    </div>
  );
}

/** Sample UI drawn with the real classes; the draft palette is applied as CSS variables on this element only. */
export function ThemePreview({ theme, mode }: { theme: CustomTheme; mode: ResolvedTheme }) {
  const t = useT();
  const style = { ...themeCssVars(theme, mode), background: "var(--bg)", color: "var(--text)" } as CSSProperties;
  return (
    <aside
      className="appearance-preview theme-preview"
      aria-label={t("appearancePreview")}
      data-testid="theme-preview"
      style={style}
    >
      <h5>{t("appearancePreview")}</h5>
      <div className="md">
        <p>{t("appearanceSampleText")}</p>
        <p style={{ color: "var(--text-2)" }}>{t("themePreviewSecondary")}</p>
      </div>
      <div className="theme-preview-chips">
        <span className="kbd-chip">Cmd K</span>
        <span style={{ color: "var(--green)" }}>OK</span>
        <span style={{ color: "var(--warn)" }}>!</span>
        <span style={{ color: "var(--red)" }}>x</span>
        <button className="btn-soft" tabIndex={-1} aria-hidden="true">
          {t("themePreviewButton")}
        </button>
      </div>
      <div className="codeblock">
        <pre>
          <span className="hljs-keyword">const</span> <span className="hljs-title">answer</span> ={" "}
          <span className="hljs-string">"42"</span>; <span className="hljs-comment">// 7 * 6</span>
        </pre>
      </div>
      <pre className="diff">
        <div className="hunk">@@ -1 +1 @@</div>
        <div className="del">- const a = 1;</div>
        <div className="add">+ const a = 2;</div>
      </pre>
    </aside>
  );
}

type Draft = { theme: CustomTheme; isNew: boolean };

/** Custom theme list, editor with live preview, and explicit Import theme / Export theme actions (JSON file). */
export function ThemeEditor() {
  const t = useT();
  const [state, setState] = useState(getCustomThemes);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<ResolvedTheme>("dark");
  const [advanced, setAdvanced] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => subscribeCustomThemes(setState), []);
  const active = state.themes.find((x) => x.id === state.activeId) ?? null;
  const say = (text: string, error = false) => setStatus({ text, error });
  const full = state.themes.length >= MAX_CUSTOM_THEMES;

  const startNew = () => {
    if (full) return say(t("themeTooMany", { max: MAX_CUSTOM_THEMES }), true);
    const name = t("themeNewName");
    setDraft({
      theme: emptyTheme(
        uniqueThemeId(
          name,
          state.themes.map((x) => x.id),
        ),
        name,
      ),
      isNew: true,
    });
    setAdvanced(false);
    setStatus(null);
  };
  const edit = () => {
    if (active) {
      setDraft({ theme: active, isNew: false });
      setAdvanced(false);
      setStatus(null);
    }
  };
  const duplicate = () => {
    if (!active) return;
    if (full) return say(t("themeTooMany", { max: MAX_CUSTOM_THEMES }), true);
    const name = duplicateName(
      active.name,
      state.themes.map((x) => x.name),
    );
    const copy = {
      ...active,
      id: uniqueThemeId(
        name,
        state.themes.map((x) => x.id),
      ),
      name,
    };
    saveCustomTheme(copy, true);
    setDraft({ theme: copy, isNew: false });
    setStatus(null);
  };
  const remove = async () => {
    if (!active) return;
    if (!(await ask(t("themeDeleteConfirm", { name: active.name }), { kind: "warning" }))) return;
    deleteCustomTheme(active.id);
    setDraft(null);
  };

  const doExport = async () => {
    if (!active) return;
    try {
      const path = await save({
        defaultPath: exportFileName(active),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      await fsx.write(path.slice(0, split) || "/", path.slice(split + 1), exportTheme(active));
      say(t("themeExported", { path }));
    } catch (e) {
      say(t("exportFailed", { error: String(e instanceof Error ? e.message : e) }), true);
    }
  };

  const doImport = async (file: File | undefined) => {
    if (!file) return;
    if (full) return say(t("themeTooMany", { max: MAX_CUSTOM_THEMES }), true);
    if (file.size > MAX_THEME_FILE_BYTES) return say(t(IMPORT_ERROR.tooLarge), true);
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      return say(t("exportFailed", { error: String(e instanceof Error ? e.message : e) }), true);
    }
    const r = parseThemeFile(text);
    if (!r.ok) return say(t(IMPORT_ERROR[r.error]) + (r.detail ? `: ${r.detail}` : ""), true);
    const names = state.themes.map((x) => x.name);
    const name = names.includes(r.name) ? duplicateName(r.name, names) : r.name;
    saveCustomTheme(
      {
        id: uniqueThemeId(
          name,
          state.themes.map((x) => x.id),
        ),
        name,
        light: r.light,
        dark: r.dark,
      },
      true,
    );
    setDraft(null);
    say(t("themeImported", { name }));
  };

  const setColor = (key: TokenKey, hex: string) => {
    if (!draft) return;
    const palette = {
      ...draft.theme[mode],
      ...(!advanced && (key === "bg" || key === "text")
        ? deriveFromBase(
            key === "bg" ? hex : draft.theme[mode].bg,
            key === "text" ? hex : draft.theme[mode].text,
            mode === "dark",
          )
        : { [key]: hex }),
    };
    setDraft({ ...draft, theme: { ...draft.theme, [mode]: palette } });
  };
  const nameOk = draft ? sanitizeThemeName(draft.theme.name) !== null : true;
  const commit = () => {
    if (!draft) return;
    const name = sanitizeThemeName(draft.theme.name);
    if (!name) return;
    if (saveCustomTheme({ ...draft.theme, name }, true)) {
      setDraft(null);
      say(t("themeSaved", { name }));
    }
  };
  const resetMode = () => {
    if (draft) setDraft({ ...draft, theme: { ...draft.theme, [mode]: { ...BASE_PALETTES[mode] } } });
  };

  const palette = draft?.theme[mode];
  const lowContrast = palette ? textContrast(palette) < MIN_TEXT_CONTRAST : false;
  const tokens = advanced ? TOKENS : TOKENS.filter((x) => x.group === "base");

  return (
    <div className={draft ? "appearance-layout" : undefined}>
      <div>
        <SettingsSection title={t("customThemes")} description={t("customThemesHint")}>
          <SettingRow id="customTheme" title={t("themeActive")}>
            <select
              className="input"
              aria-label={t("themeActive")}
              value={state.activeId}
              onChange={(e) => {
                setActiveCustomTheme(e.target.value);
                setDraft(null);
              }}
            >
              <option value="">{t("themeBuiltIn")}</option>
              {state.themes.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow id="themeActions" title={t("themeActions")}>
            <button className="btn-soft" onClick={startNew}>
              {t("themeNew")}
            </button>
            <button className="btn-soft" disabled={!active} onClick={edit}>
              {t("themeEdit")}
            </button>
            <button className="btn-soft" disabled={!active} onClick={duplicate}>
              {t("themeDuplicate")}
            </button>
            <button className="btn-soft" disabled={!active} onClick={remove}>
              {t("themeDelete")}
            </button>
          </SettingRow>
          <SettingRow id="themeImportExport" title={t("themeShare")} description={t("themeShareHint")}>
            <button className="btn-soft" onClick={() => fileRef.current?.click()}>
              {t("themeImport")}
            </button>
            <button className="btn-soft" disabled={!active} onClick={doExport}>
              {t("themeExport")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label={t("themeImport")}
              data-testid="theme-import-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                void doImport(f);
              }}
            />
          </SettingRow>
        </SettingsSection>
        {status && (
          <div
            role={status.error ? "alert" : "status"}
            className="hint"
            style={status.error ? { color: "var(--error-fg, var(--red))" } : undefined}
          >
            {status.text}
          </div>
        )}
        {draft && palette && (
          <SettingsSection title={t("themeEditor")}>
            <SettingRow id="themeName" title={t("themeName")} stacked>
              <input
                type="text"
                aria-label={t("themeName")}
                aria-invalid={!nameOk}
                maxLength={MAX_THEME_NAME}
                value={draft.theme.name}
                onChange={(e) => setDraft({ ...draft, theme: { ...draft.theme, name: e.target.value } })}
                style={{
                  width: "100%",
                  background: "var(--bg-input)",
                  border: `1px solid ${nameOk ? "var(--border)" : "var(--red)"}`,
                  borderRadius: 8,
                  padding: "4px 8px",
                  userSelect: "text",
                }}
              />
            </SettingRow>
            <SettingRow title={t("themePalette")}>
              <div className="seg" role="group" aria-label={t("themePalette")}>
                {(["light", "dark"] as const).map((m) => (
                  <button
                    key={m}
                    className={mode === m ? "active" : ""}
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                  >
                    {t(m === "light" ? "themeLight" : "themeDark")}
                  </button>
                ))}
              </div>
              <div className="seg" role="group" aria-label={t("themeEditorLevel")}>
                <button
                  className={!advanced ? "active" : ""}
                  aria-pressed={!advanced}
                  onClick={() => setAdvanced(false)}
                >
                  {t("themeEditorSimple")}
                </button>
                <button className={advanced ? "active" : ""} aria-pressed={advanced} onClick={() => setAdvanced(true)}>
                  {t("themeEditorAdvanced")}
                </button>
              </div>
            </SettingRow>
            {TOKEN_GROUPS.map((g) => {
              const items = tokens.filter((x) => x.group === g);
              if (!items.length) return null;
              return (
                <div key={g} className="card-row stacked theme-group" role="group" aria-label={t(GROUP_LABEL[g])}>
                  <div className="t">{t(GROUP_LABEL[g])}</div>
                  {!advanced && <div className="d">{t("themeSimpleHint")}</div>}
                  <div className="theme-color-grid">
                    {items.map((x) => (
                      <ColorField
                        key={x.key}
                        label={x.cssVar}
                        value={palette[x.key]}
                        onChange={(hex) => setColor(x.key, hex)}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {lowContrast && (
              <div className="card-row" role="status" style={{ color: "var(--warn)" }}>
                {t("themeContrastLow", { ratio: textContrast(palette).toFixed(1) })}
              </div>
            )}
            <div className="card-row">
              <button className="btn-soft" onClick={resetMode}>
                {t("themeResetPalette")}
              </button>
              <span className="grow" />
              <button className="btn-soft" onClick={() => setDraft(null)}>
                {t("themeCancel")}
              </button>
              <button className="btn-primary" disabled={!nameOk} onClick={commit}>
                {t("themeSave")}
              </button>
            </div>
          </SettingsSection>
        )}
      </div>
      {draft && <ThemePreview theme={draft.theme} mode={mode} />}
    </div>
  );
}
