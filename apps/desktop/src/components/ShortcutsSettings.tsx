import { useT } from "../i18n";
import { SHORTCUTS, shortcutDisplay } from "../lib/shortcuts";

/** Read-only list of the shortcuts from lib/shortcuts.ts. */
export function ShortcutsSettings() {
  const t = useT();
  return (
    <>
      <h4 aria-level={2}>{t("shortcuts")}</h4>
      <p className="h4-sub">{t("shortcutsLead")}</p>
      <div className="card">
        {SHORTCUTS.map((s) => (
          <div key={s.id} className="card-row" style={{ minHeight: 40 }}>
            <div className="grow">{t(s.label)}</div>
            <span className="kbd-chip">{shortcutDisplay(s)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
