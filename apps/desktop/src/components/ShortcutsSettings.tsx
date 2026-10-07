import { useT } from "../i18n";
import { SHORTCUTS, shortcutDisplay } from "../lib/shortcuts";
import { QuickAskSettings } from "./QuickAskSettings";

/** Read-only list of the shortcuts from lib/shortcuts.ts, then the quick-ask window switch and its recordable shortcut. */
export function ShortcutsSettings() {
  const t = useT();
  return (
    <>
      <div className="card">
        {SHORTCUTS.map((s) => (
          <div key={s.id} className="card-row" style={{ minHeight: 40 }}>
            <div className="grow">{t(s.label)}</div>
            <span className="kbd-chip">{shortcutDisplay(s)}</span>
          </div>
        ))}
      </div>
      <QuickAskSettings />
    </>
  );
}
