import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { CLEANUP_DAYS, DEFAULT_CLEANUP, type CleanupConfig } from "../lib/cleanupCore";
import { SettingRow, SettingsSection } from "./SettingRow";
import { loadCleanup, runCleanup, saveCleanup } from "../lib/storageCleanup";

/** Settings, General, "Storage": removes checkouts of idle workspace chats (lib/storageCleanup.ts). Off by default. */
export function CleanupSettings() {
  const t = useT();
  const [cfg, setCfg] = useState<CleanupConfig>(DEFAULT_CLEANUP);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void loadCleanup().then((c) => { if (alive) setCfg(c); }); return () => { alive = false; }; }, []);
  const change = (next: CleanupConfig) => { setCfg(next); void saveCleanup(next).catch(() => {}); };
  const now = async () => {
    setBusy(true); setNote("");
    try { setNote(t("cleanupDone", { n: await runCleanup(cfg.days) })); } catch { setNote(t("cleanupFailed")); } finally { setBusy(false); }
  };
  return (
    <SettingsSection title={t("cleanupTitle")}>
      <SettingRow id="cleanupAuto" title={t("cleanupAuto")} description={t("cleanupDesc")} toggle={{ on: cfg.enabled, onChange: (enabled) => change({ ...cfg, enabled }) }} />
      <SettingRow id="cleanupAfter" title={<label htmlFor="cleanup-days">{t("cleanupAfter")}</label>}>
        <select id="cleanup-days" className="input cleanup-days" value={cfg.days} onChange={(e) => change({ ...cfg, days: Number(e.target.value) })}>
          {[...new Set([...CLEANUP_DAYS, cfg.days])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{t("cleanupDays", { n: d })}</option>)}
        </select>
        <button className="btn-soft" disabled={busy} onClick={() => void now()}>{t("cleanupNow")}</button>
      </SettingRow>
      {note && <div className="card-row"><div className="d" role="status">{note}</div></div>}
    </SettingsSection>
  );
}
