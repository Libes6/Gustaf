import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { translate, useT } from "../i18n";
import { searchSettings, type SettingHit } from "../lib/settingsIndex";
import { SHORTCUTS } from "../lib/shortcuts";
import { useApp } from "../state";

/** Hits for a query in the current language and English (for the settings search field and the Cmd+K palette). */
export function useSettingsHits(query: string): SettingHit[] {
  const app = useApp();
  const shortcuts = useShortcutList();
  return useMemo(
    () => searchSettings(query, [(k) => translate(app.locale, k), (k) => translate("en", k)], shortcuts),
    [query, app.locale, shortcuts],
  );
}

// Shortcut list used by the search; replaced by the user's bindings once the shortcut editor exists.
function useShortcutList() {
  return SHORTCUTS;
}

/**
 * The search field at the top of the settings navigation. While it holds a query the navigation is replaced by the
 * matching settings (title, section); Enter or a click opens the page and highlights the row.
 */
export function SettingsSearch({ onActive }: { onActive: (active: boolean) => void }) {
  const t = useT();
  const app = useApp();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const hits = useSettingsHits(query);
  const live = query.trim().length >= 2;
  useEffect(() => onActive(query.trim().length > 0), [query]);
  useEffect(() => setActive(0), [query]);
  const open = (h: SettingHit | undefined) => {
    if (!h) return;
    app.openSettings(h.page, h.id);
    setQuery("");
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" && hits.length) { e.preventDefault(); setActive((active + 1) % hits.length); }
    else if (e.key === "ArrowUp" && hits.length) { e.preventDefault(); setActive((active - 1 + hits.length) % hits.length); }
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); open(hits[active]); }
    else if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); }
  };
  return (
    <div className="settings-search">
      <div className="settings-search-field">
        <Search size={14} aria-hidden="true" />
        <input
          type="text"
          role="combobox"
          aria-label={t("settingsSearch")}
          aria-expanded={live && hits.length > 0}
          aria-controls="settings-search-hits"
          aria-activedescendant={live && hits.length ? `settings-hit-${active}` : undefined}
          aria-autocomplete="list"
          placeholder={t("settingsSearch")}
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      {query.trim() && (
        <div id="settings-search-hits" role="listbox" aria-label={t("settingsSearch")} className="settings-search-hits">
          {hits.map((h, i) => (
            <button key={h.id} id={`settings-hit-${i}`} role="option" aria-selected={i === active} tabIndex={-1} className={`row${i === active ? " active" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => open(h)}>
              <span className="label">
                {h.title}
                <span className="d settings-hit-where">{h.detail}</span>
              </span>
              {h.keys && <span className="kbd-chip">{h.keys}</span>}
            </button>
          ))}
          {live && !hits.length && <div className="d settings-search-empty" role="status">{t("settingsSearchEmpty", { query: query.trim() })}</div>}
          {!live && <div className="d settings-search-empty">{t("settingsSearchMin")}</div>}
        </div>
      )}
    </div>
  );
}
