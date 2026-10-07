import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { mcpStdio, type McpStatus } from "../lib/api";
import { collectErrors, formatMemory, formatUptime, isHeavy, processName, scrubText, totals, type ProcInfo } from "../lib/appDiagnostics";
import { diagnose } from "../lib/providerDiagnostics";
import { useT, type Key } from "../i18n";
import { useApp } from "../state";
import { ProviderIcon } from "./ProviderIcon";
import { SettingRow } from "./SettingRow";

/** How often the process list is read while the page is open. Nothing runs when the page is closed. */
export const SAMPLE_MS = 4000;

const STATE_LABEL: Record<string, Key> = {
  ok: "provAuthenticated", auth: "provNotAuthenticated", error: "provUnavailable", cliMissing: "provUnavailable", disabled: "providerOff", unchecked: "provNotChecked",
};
const STATE_COLOR: Record<string, string> = { ok: "var(--green)", auth: "var(--yellow, #d9a33b)", error: "var(--red)", cliMissing: "var(--red)", disabled: "var(--text-3)", unchecked: "var(--text-3)" };

/** Process list of the app's own tree, sampled only while mounted (one read every SAMPLE_MS, none while the window is hidden). */
function useProcesses() {
  const [list, setList] = useState<ProcInfo[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [mcp, setMcp] = useState<McpStatus[]>([]);
  useEffect(() => {
    let alive = true;
    let busy = false;
    const sample = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const [procs, servers] = await Promise.all([invoke<ProcInfo[]>("process_snapshot"), mcpStdio.status().catch(() => [] as McpStatus[])]);
        if (!alive) return;
        setList(procs);
        setMcp(servers);
        setUnsupported(false);
      } catch {
        if (alive) setUnsupported(true);
      } finally {
        busy = false;
      }
    };
    void sample();
    const id = setInterval(sample, SAMPLE_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return { list, unsupported, mcp };
}

export function AppDiagnostics() {
  const t = useT();
  const app = useApp();
  const { list, unsupported, mcp } = useProcesses();
  const now = useRef(Date.now());
  now.current = Date.now();
  const sum = list ? totals(list) : null;
  const errors = collectErrors({ providers: app.providers, health: app.providerHealth, modelErrors: app.modelErrors, limitErrors: app.limitErrors, mcp });
  const openLogs = () => void invoke<string>("app_logs_dir").then((dir) => revealItemInDir(dir)).catch(() => {});

  return (
    <>
      <h1>{t("appDiagNav")}</h1>
      <p className="lead">{t("appDiagLead")}</p>

      <div className="card" data-testid="diag-processes">
        <SettingRow id="diagProcesses" title={t("appDiagProcesses")} description={t("appDiagProcessesDesc")}>
          {sum && <span className="d" data-testid="diag-summary">{t("appDiagSummary", { count: sum.count, memory: formatMemory(sum.rssKb), cpu: sum.cpu })}</span>}
        </SettingRow>
        {unsupported && !list && <div className="card-row d">{t("appDiagUnsupported")}</div>}
        {!unsupported && !list?.length && <div className="card-row d">{t("appDiagProcessesEmpty")}</div>}
        {list?.map((p) => (
          <div key={p.pid} className="card-row" data-testid={`diag-proc-${p.pid}`}>
            <div className="grow">
              <div className="t">
                {p.isApp ? t("appDiagApp") : processName(p.command)} <span className="d mono">#{p.pid}</span>
                {isHeavy(p) && <span className="err" style={{ marginLeft: 8 }}>{t("appDiagHeavy")}</span>}
              </div>
              <div className="d mono" style={{ overflowWrap: "anywhere" }}>{scrubText(p.command)}</div>
            </div>
            <span className="d" style={{ whiteSpace: "nowrap" }}>
              {t("appDiagCpu")} {p.cpu.toFixed(1)}% · {t("appDiagMemory")} {formatMemory(p.rssKb)} · {t("appDiagUptime", { time: formatUptime(p.elapsedSecs) })}
            </span>
          </div>
        ))}
      </div>

      <div className="card" data-testid="diag-providers">
        <SettingRow id="diagProviders" title={t("appDiagProviders")} description={t("appDiagProvidersDesc")}>
          <button className="btn-soft" onClick={() => app.openSettings("providers")}>{t("appDiagOpenProviders")}</button>
        </SettingRow>
        {!app.providers.length && <div className="card-row d">{t("appDiagProvidersEmpty")}</div>}
        {app.providers.map((p) => {
          const d = diagnose({ disabled: p.disabled, health: app.providerHealth[p.id], listError: app.modelErrors[p.id], now: now.current });
          return (
            <div key={p.id} className="card-row" data-testid={`diag-provider-${p.id}`}>
              <ProviderIcon kind={p.kind} cli={p.cli} />
              <div className="grow">
                <div className="t"><span className="status-dot" style={{ background: STATE_COLOR[d.state] }} />{p.name} · {t(STATE_LABEL[d.state])}</div>
                {d.detail && <div className="d err" style={{ whiteSpace: "pre-wrap" }}>{scrubText(d.detail)}</div>}
              </div>
              <span className="d">{d.checkedAt ? t.date(d.checkedAt) : t("provNeverChecked")}</span>
            </div>
          );
        })}
      </div>

      <div className="card" data-testid="diag-errors">
        <SettingRow id="diagErrors" title={t("appDiagErrors")} description={t("appDiagErrorsDesc")} />
        {!errors.length && <div className="card-row d">{t("appDiagErrorsNone")}</div>}
        {errors.map((e) => (
          <div key={e.id} className="card-row">
            <div className="grow">
              <div className="t">{e.source}</div>
              <div className="d err" style={{ whiteSpace: "pre-wrap" }}>{e.text}</div>
            </div>
            {e.at && <span className="d">{t.date(e.at)}</span>}
          </div>
        ))}
      </div>

      <div className="card">
        <SettingRow id="diagLogs" title={t("appDiagLogs")} description={t("appDiagLogsDesc")}>
          <button className="btn-soft" onClick={openLogs}><FolderOpen size={13} /> {t("appDiagOpenLogs")}</button>
        </SettingRow>
      </div>
    </>
  );
}
