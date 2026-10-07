import { Fragment, useState } from "react";
import { Search } from "lucide-react";
import { useT, type Key } from "../i18n";
import { displayKeys } from "../lib/platform";
import { resetShortcutBindings, saveShortcutBinding, useShortcuts } from "../lib/shortcutPrefs";
import { comboFromEvent, EDITABLE_SHORTCUTS, getShortcutOverrides, isCustomized, shortcutContext, shortcutDisplay, validateBinding, type BindingCheck, type BindingError, type ShortcutId } from "../lib/shortcuts";
import { QuickAskSettings } from "./QuickAskSettings";
import { SettingRow } from "./SettingRow";

const ERROR_KEY: Record<BindingError, Key> = { needsCmd: "shortcutErrNeedsCmd", reserved: "shortcutErrReserved", unsupported: "shortcutErrUnsupported", conflict: "shortcutErrConflict" };
const compact = (s: string) => s.toLowerCase().replace(/[\s+\-]/g, "");

/**
 * Settings -> Shortcuts: every shortcut with its keys, a search field, recording a new combination, reset per shortcut,
 * conflict and reserved-key warnings. Message-box keys and the global stop key are listed but fixed.
 * Then the quick-ask window switch and its recordable shortcut.
 */
export function ShortcutsSettings() {
  const t = useT();
  const list = useShortcuts();
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<{ id: ShortcutId; text: string } | null>(null);
  const q = query.trim().toLowerCase();
  const shown = list.filter((s) => !q || `${t(s.label)} ${s.label}`.toLowerCase().includes(q) || compact(`${shortcutDisplay(s)} ${displayKeys(s.display, "windows")} ${s.combo}`).includes(compact(q)));
  const anyCustom = Object.keys(getShortcutOverrides()).length > 0;

  const record = (id: ShortcutId, e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(null);
    const combo = comboFromEvent(e.nativeEvent);
    if (combo === null) return;
    const mod = displayKeys("⌘").replace(/\+$/, "");
    const check: BindingCheck = combo === "" ? { ok: false, error: "unsupported" } : validateBinding(id, combo, list);
    if (!check.ok) {
      const other = check.with ? list.find((s) => s.id === check.with) : undefined;
      setError({ id, text: t(ERROR_KEY[check.error], { mod, name: other ? t(other.label) : "", where: other ? t(`shortcutCtx_${shortcutContext(other)}` as Key) : "" }) });
      return;
    }
    setError(null);
    setRecording(null);
    void saveShortcutBinding(id, combo).catch(() => {});
  };

  return (
    <>
      <div className="settings-search-field shortcut-search">
        <Search size={14} aria-hidden="true" />
        <input type="text" aria-label={t("shortcutsSearch")} placeholder={t("shortcutsSearch")} spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="card">
        {shown.map((s) => {
          const editable = EDITABLE_SHORTCUTS.includes(s.id);
          return (
            <Fragment key={s.id}>
              <SettingRow id={`shortcut-${s.id}`} title={t(s.label)} description={t(`shortcutCtx_${shortcutContext(s)}` as Key)}>
                {recording === s.id ? (
                  <button
                    type="button"
                    className="kbd-chip kbd-chip-edit kbd-chip-recording"
                    autoFocus
                    aria-label={t("shortcutRecording")}
                    onBlur={() => (setRecording(null), setError(null))}
                    onKeyDown={(e) => record(s.id, e)}
                  >
                    {t("shortcutRecording")}
                  </button>
                ) : editable ? (
                  <>
                    <button
                      type="button"
                      className="kbd-chip kbd-chip-edit"
                      aria-label={`${t("shortcutChange")}: ${t(s.label)}`}
                      title={t("shortcutChange")}
                      onClick={() => (setError(null), setRecording(s.id))}
                    >
                      {shortcutDisplay(s)}
                    </button>
                    {isCustomized(s.id) && <button className="btn-soft" aria-label={`${t("shortcutReset")}: ${t(s.label)}`} onClick={() => (setError(null), void saveShortcutBinding(s.id, null).catch(() => {}))}>{t("shortcutReset")}</button>}
                  </>
                ) : (
                  <>
                    <span className="kbd-chip">{shortcutDisplay(s)}</span>
                    <span className="d">{t("shortcutFixed")}</span>
                  </>
                )}
              </SettingRow>
              {error?.id === s.id && <div className="card-row"><div className="d shortcut-error" role="alert">{error.text}</div></div>}
            </Fragment>
          );
        })}
        {!shown.length && <div className="card-row d" role="status">{t("shortcutsNoMatch", { query: query.trim() })}</div>}
      </div>
      {anyCustom && <p className="h4-sub"><button className="btn-soft" onClick={() => (setError(null), void resetShortcutBindings().catch(() => {}))}>{t("shortcutResetAll")}</button></p>}
      <QuickAskSettings />
    </>
  );
}
