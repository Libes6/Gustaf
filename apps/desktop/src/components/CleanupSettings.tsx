import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { CLEANUP_DAYS, DEFAULT_CLEANUP, LOG_DAYS, type CleanupConfig, type CleanupPreview } from "../lib/cleanupCore";
import { SettingRow, SettingsSection } from "./SettingRow";
import { cleanupLogs, loadCleanup, previewCleanup, runCleanup, saveCleanup } from "../lib/storageCleanup";

const options = (base: readonly number[], current: number) => [...new Set([...base, current])].sort((a, b) => a - b);
const mb = (bytes: number) => (bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1);

/**
 * Settings, "Storage": two independent policies (lib/storageCleanup.ts), each with its own switch and period.
 * Workspaces: the checkout folder of an idle workspace chat. Logs: old raw CLI log day files. Both are off by default
 * and both can be previewed before anything is deleted.
 */
export function CleanupSettings() {
  const t = useT();
  const [cfg, setCfg] = useState<CleanupConfig>(DEFAULT_CLEANUP);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  useEffect(() => { let alive = true; void loadCleanup().then((c) => { if (alive) setCfg(c); }); return () => { alive = false; }; }, []);
  const change = (next: CleanupConfig) => { setCfg(next); setPreview(null); void saveCleanup(next).catch(() => {}); };
  const show = async () => {
    setBusy(true); setNote("");
    try { setPreview(await previewCleanup(cfg)); } catch { setNote(t("cleanupFailed")); } finally { setBusy(false); }
  };
  const run = async () => {
    setBusy(true); setNote("");
    try {
      const folders = await runCleanup(cfg.days);
      const logs = (await cleanupLogs(cfg.logsDays, false).catch(() => ({ files: [] as string[] }))).files.length;
      setNote(`${t("cleanupDone", { n: folders })}. ${t("cleanupLogsDone", { n: logs })}`);
      setPreview(null);
    } catch { setNote(t("cleanupFailed")); } finally { setBusy(false); }
  };
  const empty = !!preview && preview.workspaces.length === 0 && preview.logFiles.length === 0;
  return (
    <SettingsSection title={t("cleanupTitle")} description={t("cleanupExplain")}>
      <SettingRow id="cleanupAuto" title={t("cleanupAuto")} description={t("cleanupDesc")} toggle={{ on: cfg.enabled, onChange: (enabled) => change({ ...cfg, enabled }) }} />
      <SettingRow id="cleanupAfter" title={<label htmlFor="cleanup-days">{t("cleanupAfter")}</label>}>
        <select id="cleanup-days" className="input cleanup-days" value={cfg.days} onChange={(e) => change({ ...cfg, days: Number(e.target.value) })}>
          {options(CLEANUP_DAYS, cfg.days).map((d) => <option key={d} value={d}>{t("cleanupDays", { n: d })}</option>)}
        </select>
      </SettingRow>
      <SettingRow id="cleanupLogsAuto" title={t("cleanupLogsAuto")} description={t("cleanupLogsDesc")} toggle={{ on: cfg.logsEnabled, onChange: (logsEnabled) => change({ ...cfg, logsEnabled }) }} />
      <SettingRow id="cleanupLogsAfter" title={<label htmlFor="cleanup-logs-days">{t("cleanupLogsAfter")}</label>}>
        <select id="cleanup-logs-days" className="input cleanup-days" value={cfg.logsDays} onChange={(e) => change({ ...cfg, logsDays: Number(e.target.value) })}>
          {options(LOG_DAYS, cfg.logsDays).map((d) => <option key={d} value={d}>{t("cleanupDays", { n: d })}</option>)}
        </select>
      </SettingRow>
      <SettingRow id="cleanupNow" title={t("cleanupNowTitle")} description={t("cleanupNowDesc")}>
        <button className="btn-soft" disabled={busy} onClick={() => void show()}>{t("cleanupPreview")}</button>
        <button className="btn-soft" disabled={busy || !preview || empty} onClick={() => void run()}>{t("cleanupNow")}</button>
      </SettingRow>
      {preview && (
        <div className="card-row" data-testid="cleanup-preview">
          <div className="d" role="status">
            {empty ? t("cleanupNothing") : (
              <>
                {preview.workspaces.length > 0 && (
                  <div>
                    <b>{t("cleanupPreviewWorkspaces", { n: preview.workspaces.length })}</b>
                    <ul>{preview.workspaces.map((w) => <li key={w.taskId} title={w.path}>{w.branch}</li>)}</ul>
                  </div>
                )}
                {preview.logFiles.length > 0 && (
                  <div>
                    <b>{t("cleanupPreviewLogs", { n: preview.logFiles.length, mb: mb(preview.logBytes) })}</b>
                    <ul>{preview.logFiles.map((f) => <li key={f}>{f}</li>)}</ul>
                  </div>
                )}
              </>
            )}
            {preview.keptDirty > 0 && <div>{t("cleanupKeptDirty", { n: preview.keptDirty })}</div>}
          </div>
        </div>
      )}
      {note && <div className="card-row"><div className="d" role="status">{note}</div></div>}
    </SettingsSection>
  );
}
