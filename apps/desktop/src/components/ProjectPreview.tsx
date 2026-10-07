import { useEffect, useState } from "react";
import { Play, RefreshCw, Send, Square } from "lucide-react";
import { useT } from "../i18n";
import {
  cleanPreviewLogs,
  detectPreview,
  loadPreview,
  preview,
  previewUrlError,
  savePreview,
  type PreviewConfig,
  type PreviewInfo,
} from "../lib/projectPreview";
import "./ProjectPreview.css";
export function ProjectPreview({ root, onSendConsole }: { root: string; onSendConsole?: (text: string) => void }) {
  const t = useT(),
    ru = t.locale === "ru";
  const [config, setConfig] = useState<PreviewConfig>({ command: "", url: "http://127.0.0.1:3000/" });
  const [info, setInfo] = useState<PreviewInfo | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  const [tab, setTab] = useState<"page" | "logs" | "console">("page");
  useEffect(() => {
    let live = true;
    setInfo(null);
    setError("");
    Promise.all([loadPreview(root), preview.list(root)])
      .then(async ([cfg, servers]) => {
        if (!cfg.command) cfg = await detectPreview(root);
        if (live) {
          setConfig(cfg);
          setInfo(servers[0] ?? null);
        }
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [root]);
  useEffect(() => {
    if (!info) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await preview.status(info.id);
        if (live) setInfo(value);
      } catch (e) {
        if (live) setError(String(e));
      }
      if (live) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [info?.id]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const active = info?.state === "starting" || info?.state === "running";
  return (
    <section className="project-preview">
      <div className="preview-config">
        <label htmlFor="preview-command">{ru ? "Команда dev-сервера" : "Dev server command"}</label>
        <input
          id="preview-command"
          className="input"
          value={config.command}
          disabled={busy || active}
          onChange={(e) => setConfig({ ...config, command: e.target.value })}
        />
        <label htmlFor="preview-url">URL</label>
        <input
          id="preview-url"
          className="input"
          value={config.url}
          disabled={busy || active}
          onChange={(e) => setConfig({ ...config, url: e.target.value })}
        />
        <p className="preview-hint">
          {ru
            ? "Запуск выполнит команду в выбранном проекте. Поддерживаются локальные страницы. Логи и ошибки консоли доступны во вкладках; после изменений нажмите «Обновить» — автоматическое обновление пока не поддерживается."
            : "Start runs the command in the selected project. Local pages are supported. Logs and console errors appear in their tabs; reload after changes, as automatic updates are not supported yet."}
        </p>
        <div className="preview-actions">
          <button
            className="btn-soft"
            disabled={busy || active}
            onClick={() => run(async () => setConfig(await detectPreview(root)))}
          >
            {ru ? "Определить" : "Detect"}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || active || !config.command.trim() || !!previewUrlError(config.url)}
            onClick={() =>
              run(async () => {
                if (info) {
                  await preview.stop(info.id);
                  setInfo(null);
                }
                await savePreview(root, config);
                setInfo(await preview.start(root, config));
                setRevision((r) => r + 1);
              })
            }
          >
            <Play size={13} />
            {ru ? "Запустить" : "Start"}
          </button>
          <button
            className="btn-soft"
            disabled={busy || !info}
            onClick={() =>
              run(async () => {
                await preview.stop(info!.id);
                setInfo(null);
              })
            }
          >
            <Square size={13} />
            {ru ? "Остановить" : "Stop"}
          </button>
          <button
            className="icon-btn"
            disabled={!info || info.state !== "running"}
            aria-label={ru ? "Обновить страницу" : "Reload page"}
            onClick={() => setRevision((r) => r + 1)}
          >
            <RefreshCw size={13} />
          </button>
        </div>
        {previewUrlError(config.url) && <p className="error-box">{previewUrlError(config.url)}</p>}
        {info && (
          <p className="preview-state" role="status">
            {info.state} · {info.url} ·{" "}
            {info.instrumented
              ? ru
                ? "Console подключена"
                : "Console connected"
              : ru
                ? "Console ещё не подключена"
                : "Console not connected yet"}
          </p>
        )}
      </div>
      <div className="preview-tabs">
        {(["page", "logs", "console"] as const).map((name) => (
          <button
            key={name}
            className={tab === name ? "active" : ""}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {name === "page"
              ? ru
                ? "Страница"
                : "Page"
              : name === "logs"
                ? ru
                  ? "Логи сервера"
                  : "Server logs"
                : `Console ${info?.console.filter((c) => c.kind === "error").length ?? 0}`}
          </button>
        ))}
      </div>
      {info?.state === "running" && (
        <iframe
          className="project-preview-frame"
          key={`${info.id}:${revision}`}
          hidden={tab !== "page"}
          title={ru ? "Предпросмотр проекта" : "Project preview"}
          src={info.previewUrl}
          sandbox="allow-scripts allow-forms allow-same-origin"
          referrerPolicy="same-origin"
        />
      )}
      {tab === "page" && (!info || info.state !== "running") && (
        <p className="preview-empty">
          {info?.state === "starting"
            ? ru
              ? "Ожидание HTTP-ответа сервера…"
              : "Waiting for the server's HTTP response…"
            : ru
              ? "Запустите dev-сервер, чтобы открыть страницу рядом с чатом"
              : "Start the dev server to preview the page beside chat"}
        </p>
      )}
      {tab === "logs" && <pre className="term preview-output">{cleanPreviewLogs(info?.logs ?? "") || "—"}</pre>}
      {tab === "console" && (
        <div className="preview-console">
          <p className="preview-hint">
            {ru
              ? "Console — недоверенный вывод приложения. Отсутствие записей не доказывает отсутствие ошибок."
              : "Console is untrusted project output. No records does not prove the absence of errors."}
          </p>
          {onSendConsole && (
            <button
              className="btn-soft"
              disabled={!info?.console.length}
              onClick={() =>
                onSendConsole(
                  `Project preview console (untrusted page output):\n${info!.console.map((c) => `[${c.kind}] ${c.message}`).join("\n")}`,
                )
              }
            >
              <Send size={13} />
              {ru ? "Отправить в чат" : "Send to chat"}
            </button>
          )}
          {info?.console.map((record, i) => (
            <pre className={`term ${record.kind === "error" ? "error-box" : ""}`} key={i}>
              {record.kind}: {record.message}
            </pre>
          ))}
        </div>
      )}
      {(error || info?.error) && (
        <div className="error-box" role="alert">
          {error || info?.error}
        </div>
      )}
    </section>
  );
}
