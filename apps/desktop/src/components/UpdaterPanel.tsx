import { getVersion } from "@tauri-apps/api/app";
import { useEffect, useState } from "react";
import { useApp } from "../state";
import { configuredUpdateTransport, UpdateController, type UpdateStatus, type UpdateTransport } from "../lib/updates";
/** Local builds stay disabled; provisioned builds discover the official signed native transport. */
export function UpdaterPanel({ transport }: { transport?: UpdateTransport }) {
  const ru = useApp().locale === "ru";
  const [status, setStatus] = useState<UpdateStatus>(() => new UpdateController(transport).status);
  const [controller, setController] = useState(() => new UpdateController(transport, setStatus));
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (transport) return;
    let alive = true;
    configuredUpdateTransport().then(native => {
      if (!alive || !native) return;
      const next = new UpdateController(native, setStatus);
      setController(next); setStatus(next.status);
    }, error => { if (alive) setStatus({ kind: "error", error: String(error) }); });
    return () => { alive = false; };
  }, [transport]);
  useEffect(() => { let alive = true; getVersion().then(v => { if (alive) setVersion(v); }, () => {}); return () => { alive = false; }; }, []);
  const label = ru ? {
    disabled: "Обновления пока не настроены: нет сервера и публичного ключа подписи.", idle: "Проверка запускается вручную.", checking: "Проверяем…", current: "Доступных обновлений нет.", available: "Доступно обновление", downloading: "Скачивание и проверка подписи…", downloaded: "Подпись проверена. Обновление готово к установке.", installing: "Установка…", error: "Ошибка обновления",
  } : { disabled: "Updates are not configured: no endpoint or signing public key.", idle: "Check manually for updates.", checking: "Checking…", current: "No update available.", available: "Update available", downloading: "Downloading and verifying signature…", downloaded: "Signature verified. Ready to install.", installing: "Installing…", error: "Update failed" };
  return <>
    <h4>{ru ? "Обновления приложения" : "Application updates"}</h4>
    <div className="card"><div className="card-row"><div className="grow">
      <div className="t">M Code {version || (ru ? "— версия недоступна" : "— version unavailable")}</div>
      <div className="d" role="status">{label[status.kind]} {"version" in status ? status.version : ""}</div>
    </div><button className="btn-soft" disabled={["disabled", "checking", "downloading", "installing"].includes(status.kind)} onClick={() => void controller.check()}>{ru ? "Проверить" : "Check"}</button></div>
    {"notes" in status && status.notes && <div className="card-row" style={{ whiteSpace: "pre-wrap" }}>{status.notes}</div>}
    {status.kind === "available" && <div className="card-row"><button className="btn-soft" onClick={() => void controller.download()}>{ru ? "Скачать" : "Download"}</button></div>}
    {status.kind === "downloading" && <div className="card-row">{Math.round((status.received ?? 0) / 1024)} KiB {status.total ? `/ ${Math.round(status.total / 1024)} KiB` : ""}</div>}
    {status.kind === "downloaded" && <div className="card-row"><button className="btn-soft" onClick={() => void controller.install()}>{ru ? "Установить и перезапустить" : "Install and restart"}</button></div>}
    {status.kind === "error" && <div className="error-box" role="alert">{status.error}</div>}</div>
  </>;
}
