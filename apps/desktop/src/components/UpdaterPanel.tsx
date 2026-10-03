import { getVersion } from "@tauri-apps/api/app";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useApp } from "../state";
import { configuredUpdateTransport, updateError, UpdateController, type UpdateStatus, type UpdateTransport } from "../lib/updates";
import { getLiveChats, subscribeLiveRuns } from "../lib/liveRuns";
import { getRunner, useRunnerVersion } from "../lib/scheduledRuntime";
const UpdateContext = createContext<ReturnType<typeof useUpdates> | null>(null);
function useUpdates(transport?: UpdateTransport) {
  const [status, setStatus] = useState<UpdateStatus>(() => new UpdateController(transport).status);
  const [controller, setController] = useState(() => new UpdateController(transport, setStatus));
  const [version, setVersion] = useState("");
  useEffect(() => {
    let alive = true;
    const start = async () => {
      const native = transport ?? await configuredUpdateTransport();
      if (!alive || !native) return;
      const next = new UpdateController(native, s => { if (alive) setStatus(s); });
      setController(next); await next.check();
    };
    void start().catch(error => { if (alive) setStatus(updateError(error)); });
    return () => { alive = false; };
  }, [transport]);
  useEffect(() => { let alive = true; getVersion().then(v => { if (alive) setVersion(v); }, () => {}); return () => { alive = false; }; }, []);
  return { status, controller, version };
}
export function UpdatesProvider({ children, transport }: { children: ReactNode; transport?: UpdateTransport }) {
  const value = useUpdates(transport);
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}
export function UpdateNotice() {
  const updates = useContext(UpdateContext);
  const app = useApp();
  if (updates?.status.kind !== "available" && updates?.status.kind !== "downloaded") return null;
  return <div className="budget-banner" role="status"><button className="btn-soft" onClick={() => { app.openSettings("general"); }}>{app.locale === "ru" ? "Доступно обновление" : "Update available"} {updates.status.version}</button></div>;
}
export function UpdaterPanel({ transport }: { transport?: UpdateTransport }) {
  const shared = useContext(UpdateContext);
  if (shared && !transport) return <UpdaterContents updates={shared} />;
  return <StandaloneUpdater transport={transport} />;
}
function StandaloneUpdater({ transport }: { transport?: UpdateTransport }) {
  return <UpdaterContents updates={useUpdates(transport)} />;
}
function UpdaterContents({ updates: { status, controller, version } }: { updates: ReturnType<typeof useUpdates> }) {
  const app = useApp();
  const ru = app.locale === "ru";
  const live = useSyncExternalStore(subscribeLiveRuns, getLiveChats);
  useRunnerVersion();
  const active = app.sessions.items.some(session => session.busy) || live.size > 0 || (getRunner()?.running().size ?? 0) > 0;
  const activeRef = useRef(active); activeRef.current = active;
  const [confirming, setConfirming] = useState(false);
  const [allowInterrupt, setAllowInterrupt] = useState(false);
  const install = () => {
    if ((activeRef.current || getLiveChats().size > 0 || (getRunner()?.running().size ?? 0) > 0) && !allowInterrupt) return;
    setConfirming(false); void controller.install();
  };
  const label = ru ? {
    disabled: "Обновления недоступны: сборка без ключа подписи или неподдерживаемый формат установки.", idle: "Проверка при запуске и вручную.", checking: "Проверяем…", current: "Доступных обновлений нет.", available: "Доступно обновление", downloading: "Скачивание и проверка подписи…", downloaded: "Подпись проверена. Обновление готово к установке.", installing: "Установка…", error: "Ошибка обновления",
  } : { disabled: "Updates are unavailable: build unconfigured or installation format unsupported.", idle: "Checks at startup and manually.", checking: "Checking…", current: "No update available.", available: "Update available", downloading: "Downloading and verifying signature…", downloaded: "Signature verified. Ready to install.", installing: "Installing…", error: "Update failed" };
  return <>
    <h4>{ru ? "Обновления приложения" : "Application updates"}</h4>
    <div className="card"><div className="card-row"><div className="grow">
      <div className="t">Gustaf {version || (ru ? "— версия недоступна" : "— version unavailable")}</div>
      <div className="d" role="status">{label[status.kind]} {"version" in status ? status.version : ""}</div>
    </div><button className="btn-soft" disabled={["disabled", "checking", "downloading", "installing"].includes(status.kind)} onClick={() => void controller.check()}>{ru ? "Проверить" : "Check"}</button></div>
    {"notes" in status && status.notes && <div className="card-row" style={{ whiteSpace: "pre-wrap" }}>{status.notes}</div>}
    {status.kind === "available" && <div className="card-row"><button className="btn-soft" onClick={() => void controller.download()}>{ru ? "Скачать" : "Download"}</button></div>}
    {status.kind === "downloading" && <div className="card-row"><progress aria-label={ru ? "Загрузка обновления" : "Update download"} max={status.total || 1} value={status.total ? Math.min(status.received ?? 0, status.total) : undefined} /> {Math.round((status.received ?? 0) / 1024)} KiB {status.total ? `/ ${Math.round(status.total / 1024)} KiB` : ""}</div>}
    {status.kind === "downloaded" && <div className="card-row"><button className="btn-soft" onClick={() => { setAllowInterrupt(false); setConfirming(true); }}>{ru ? "Установить и перезапустить" : "Install and restart"}</button></div>}
    {confirming && status.kind === "downloaded" && <div className="card-row" role="dialog" aria-label={ru ? "Подтвердить установку" : "Confirm installation"}>
      <div>{ru ? "Установить обновление и перезапустить приложение?" : "Install the update and restart the application?"}</div>
      {active && <label><input type="checkbox" checked={allowInterrupt} onChange={e => setAllowInterrupt(e.target.checked)} />{ru ? "Разрешаю прервать активную генерацию" : "Allow interrupting active generation"}</label>}
      <button className="btn-soft" disabled={active && !allowInterrupt} onClick={install}>{ru ? "Подтвердить перезапуск" : "Confirm restart"}</button>
      <button className="btn-soft" onClick={() => setConfirming(false)}>{ru ? "Отмена" : "Cancel"}</button>
    </div>}
    <div className="d">{ru ? "Linux: обновление внутри приложения доступно только для AppImage. DEB/RPM обновляйте вручную." : "Linux: in-app updates require AppImage. Update DEB/RPM manually."}</div>
    {status.kind === "error" && <div className="error-box" role="alert">{status.category === "signature" ? (ru ? "Подпись не прошла проверку. Установка заблокирована. " : "Signature verification failed. Installation blocked. ") : status.category === "network" ? (ru ? "Проверьте подключение и повторите проверку. " : "Check your connection and retry. ") : ""}{status.error}</div>}</div>
  </>;
}
