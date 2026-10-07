import { SettingRow } from "./SettingRow";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useApp } from "../state";
import {
  detectDiagnostics,
  detectLanguageServers,
  languageForPath,
  loadDiagnostics,
  runLspDiagnostics,
  saveDiagnostics,
  type DiagnosticsConfig,
  type LanguageServer,
  type LspReport,
} from "../agent/diagnostics";
import { DiagnosticsList } from "./DiagnosticsList";
export function DiagnosticsSettings() {
  const t = useT();
  const ru = t.locale === "ru";
  const app = useApp();
  const projects = app.projects.filter((p) => p.path);
  const [root, setRoot] = useState(projects[0]?.path ?? "");
  const [config, setConfig] = useState<DiagnosticsConfig>({
    enabled: false,
    command: "",
    timeoutMs: 30000,
    engine: "command",
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [servers, setServers] = useState<LanguageServer[]>([]);
  const [path, setPath] = useState("");
  const [report, setReport] = useState<LspReport | null>(null);
  useEffect(() => {
    let live = true;
    setSaved(false);
    setReport(null);
    setServers([]);
    if (root) {
      loadDiagnostics(root)
        .then((c) => live && setConfig(c))
        .catch((e) => live && setError(String(e)));
      detectLanguageServers(root)
        .then((s) => live && setServers(s ?? []))
        .catch((e) => live && setError(String(e)));
    }
    return () => {
      live = false;
    };
  }, [root]);
  const change = (next: DiagnosticsConfig) => {
    setConfig(next);
    setSaved(false);
  };
  const server = servers.find((s) => s.language === languageForPath(path));
  return (
    <>
      <h4>{t("diagnosticsTitle")}</h4>
      <p className="lead">{t("diagnosticsLead")}</p>
      {!projects.length ? (
        <p>{t("diagnosticsNoProject")}</p>
      ) : (
        <>
          <select
            className="input"
            aria-label={t("searchProject")}
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            disabled={busy}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.path!}>
                {p.name}
              </option>
            ))}
          </select>
          <label htmlFor="diagnostics-engine">{ru ? "Источник диагностики" : "Diagnostic source"}</label>
          <select
            id="diagnostics-engine"
            className="input"
            value={config.engine ?? "command"}
            onChange={(e) => change({ ...config, engine: e.target.value as "lsp" | "command" })}
          >
            <option value="command">{ru ? "Команда проекта" : "Project command"}</option>
            <option value="lsp">
              {ru ? "Языковой сервер (LSP) + резервная команда" : "Language server (LSP) + command fallback"}
            </option>
          </select>
          <SettingRow id="diagnosticsAuto" title={<label htmlFor="diagnostics-enabled">{t("diagnosticsAuto")}</label>}>
            <input
              id="diagnostics-enabled"
              type="checkbox"
              checked={config.enabled}
              onChange={(e) => change({ ...config, enabled: e.target.checked })}
            />
          </SettingRow>
          {config.engine === "lsp" && (
            <div className="card">
              <p className="hint">
                {ru
                  ? "Используются только уже установленные TypeScript, Rust или Python серверы. Запуск анализа может выполнять скрипты проекта; агент запросит разрешение. Отсутствующий сервер не устанавливается автоматически."
                  : "Uses installed TypeScript, Rust or Python servers only. Analysis can execute project scripts; the agent asks permission before launch. Missing servers are never installed automatically."}
              </p>
              {!servers.length && (
                <p className="hint">
                  {ru
                    ? "Языковые серверы не найдены. Доступна резервная команда ниже."
                    : "No language servers found. Configure a command fallback below."}
                </p>
              )}
              {servers.map((s) => (
                <div className="card-row" key={s.language}>
                  <strong>{s.language}</strong>
                  <code style={{ overflowWrap: "anywhere" }}>
                    {s.command} {s.args.join(" ")}
                  </code>
                </div>
              ))}
              <label htmlFor="diagnostics-file">
                {ru ? "Файл для проверки (относительно проекта)" : "File to check (relative to project)"}
              </label>
              <input
                id="diagnostics-file"
                className="input"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setReport(null);
                }}
                placeholder="src/main.ts"
                disabled={busy}
              />
              <button
                className="btn-soft"
                disabled={busy || !server || !path.trim()}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    setReport(await runLspDiagnostics(root, path, config.timeoutMs));
                  } catch (e) {
                    setError(String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {ru ? "Запустить LSP-проверку файла" : "Run LSP file check"}
              </button>
              {report && <DiagnosticsList report={report} root={root} />}
            </div>
          )}
          <label htmlFor="diagnostics-command">
            {config.engine === "lsp"
              ? ru
                ? "Резервная команда (если сервер недоступен)"
                : "Fallback command (when server unavailable)"
              : t("diagnosticsCommand")}
          </label>
          <input
            id="diagnostics-command"
            className="input"
            value={config.command}
            onChange={(e) => change({ ...config, command: e.target.value })}
          />
          <div className="card-row">
            <button
              className="btn-soft"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const command = await detectDiagnostics(root);
                  change({ ...config, command });
                  if (!command) setError(t("diagnosticsNoCommand"));
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("diagnosticsDetect")}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || (config.engine !== "lsp" && !config.command.trim())}
              onClick={async () => {
                setBusy(true);
                try {
                  await saveDiagnostics(root, config);
                  setSaved(true);
                  setError("");
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("save")}
            </button>
            {saved && <span role="status">{t("diagnosticsSaved")}</span>}
          </div>
        </>
      )}
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
