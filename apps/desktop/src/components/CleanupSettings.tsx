import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { CLEANUP_DAYS, DEFAULT_CLEANUP, type CleanupConfig } from "../lib/cleanupCore";
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
    <>
      <h4 aria-level={2}>{t("cleanupTitle")}</h4>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t" id="cleanup-title">{t("cleanupAuto")}</div>
            <div className="d">{t("cleanupDesc")}</div>
          </div>
          <button role="switch" aria-checked={cfg.enabled} aria-labelledby="cleanup-title" className={`toggle${cfg.enabled ? " on" : ""}`} onClick={() => change({ ...cfg, enabled: !cfg.enabled })} />
        </div>
        <div className="card-row">
          <label className="grow" htmlFor="cleanup-days">{t("cleanupAfter")}</label>
          <select id="cleanup-days" className="input cleanup-days" value={cfg.days} onChange={(e) => change({ ...cfg, days: Number(e.target.value) })}>
            {[...new Set([...CLEANUP_DAYS, cfg.days])].sort((a, b) => a - b).map((d) => <option key={d} value={d}>{t("cleanupDays", { n: d })}</option>)}
          </select>
          <button className="btn-soft" disabled={busy} onClick={() => void now()}>{t("cleanupNow")}</button>
        </div>
        {note && <div className="card-row"><div className="d" role="status">{note}</div></div>}
      </div>
    </>
  );
}
