import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { rawLog, type RawLogInfo } from "../lib/api";
import { isMac, isWindows } from "../lib/platform";
import { rawLogEnabled, setRawLogEnabled } from "../lib/rawCliLog";

const size = (bytes: number) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Settings, General, "Developer": opt-in capture of the raw event lines of agent CLIs (src/lib/rawCliLog.ts). Off by default. */
export function DeveloperSettings() {
  const t = useT();
  const [on, setOn] = useState(false);
  const [info, setInfo] = useState<RawLogInfo | null>(null);
  const [err, setErr] = useState("");
  const refresh = () => rawLog.info().then(setInfo).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => {
    let alive = true;
    rawLogEnabled().then((v) => { if (alive) setOn(v); });
    void refresh();
    return () => { alive = false; };
  }, []);
  const toggle = async (v: boolean) => {
    setOn(v);
    try { await setRawLogEnabled(v); setErr(""); } catch (e: any) { setOn(!v); setErr(String(e?.message ?? e)); }
  };
  const reveal = async () => {
    try { await revealItemInDir(info?.latest ?? info?.dir ?? (await rawLog.info()).dir); } catch (e: any) { setErr(String(e?.message ?? e)); }
  };
  const clear = async () => {
    try { await rawLog.clear(); setErr(""); } catch (e: any) { setErr(String(e?.message ?? e)); }
    await refresh();
  };
  return (
    <>
      <h4 aria-level={2}>{t("developer")}</h4>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t" id="raw-log-title">{t("rawLogTitle")}</div>
            <div className="d">{t("rawLogDesc")}</div>
          </div>
          <button role="switch" aria-checked={on} aria-labelledby="raw-log-title" className={`toggle${on ? " on" : ""}`} onClick={() => void toggle(!on)} />
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="d" role="status">{info ? t("rawLogSize", { files: info.files, size: size(info.bytes) }) : ""}</div>
          </div>
          <button className="btn-soft" onClick={() => void reveal()}>{t(isMac() ? "showInFinder" : isWindows() ? "showInExplorer" : "showInFileManager")}</button>
          <button className="btn-soft" disabled={!info || info.files === 0} onClick={() => void clear()}>{t("rawLogClear")}</button>
        </div>
        {err && <div className="error-box" role="alert">{err}</div>}
      </div>
    </>
  );
}
