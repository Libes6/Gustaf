import { SemanticSettings } from "./SemanticSettings";
import { KnowledgeSettings } from "./KnowledgeSettings";
import { BookOpen } from "lucide-react";
import { WebSettings } from "./WebSettings";
import { UpdaterPanel } from "./UpdaterPanel";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Activity, Archive, BarChart3, HardDrive, Globe, Smartphone, Clock, Download, FileText, GitBranch, History, Monitor, MousePointer2, Plug, Settings as Gear, Undo2, Boxes, Keyboard,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { loadProjectInstructions } from "../agent/instructionsStore";
import { useT, type Key } from "../i18n";
import { displayKeys, isMac } from "../lib/platform";
import { shortcut, shortcutDisplay } from "../lib/shortcuts";
import { computer, getSetting } from "../lib/api";
import { archiveChat, listArchived, type Chat, type ImportRecord } from "../lib/data";
import { SOURCE_LABELS } from "../lib/importers/common";
import type { ProviderConfig } from "../providers/types";
import { useApp, type SettingsPage } from "../state";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { AppDiagnostics } from "./AppDiagnostics";
import { AutoReviewSettings } from "./AutoReviewSettings";
import { MemorySettings } from "./MemorySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { CleanupSettings } from "./CleanupSettings";
import { BudgetsSection } from "./Budgets";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { CommandRules } from "./CommandRules";
import { HooksSettings } from "./HooksSettings";
import { VerificationSettings } from "./VerificationSettings";
import { ChatTransfer, ImportPanel } from "./ImportPanel";
import { McpServers } from "./McpServers";
import { MobileSettings } from "./MobileSettings";
import { ProvidersPage } from "./ProvidersPage";
import { ModelIcon } from "./ModelIcon";
import { ProviderIcon } from "./ProviderIcon";
import { ScheduledPage } from "./ScheduledPromptsSection";
import { ShortcutsSettings } from "./ShortcutsSettings";
import { SettingRow } from "./SettingRow";
import { SettingsSearch } from "./SettingsSearch";

const NAV: { group: Key; items: { id: SettingsPage; label: Key; icon: typeof Gear }[] }[] = [
  {
    group: "personal",
    items: [
      { id: "general", label: "general", icon: Gear },
      { id: "shortcuts", label: "shortcuts", icon: Keyboard },
      { id: "storage", label: "cleanupTitle", icon: HardDrive },
      { id: "import", label: "import", icon: Download },
      { id: "providers", label: "providers", icon: Boxes },
      { id: "usage", label: "usage", icon: BarChart3 },
      { id: "memory", label: "memoryTitle", icon: FileText },
      { id: "diagnostics", label: "appDiagNav", icon: Activity },
    ],
  },
  { group: "integrations", items: [{ id: "computer", label: "computerUse", icon: Monitor }, { id: "web", label: "webTools", icon: Globe }, { id: "mcp", label: "mcp", icon: Plug }, { id: "scheduled", label: "scheduledNav", icon: Clock }, { id: "knowledge", label: "knowledgeNav", icon: BookOpen }, { id: "mobile", label: "mobileTitle", icon: Smartphone }] },
  { group: "code", items: [{ id: "git", label: "gitAndCommands", icon: GitBranch }, { id: "rules", label: "rules", icon: FileText }] },
  { group: "archiveGroup", items: [{ id: "archive", label: "archivedChats", icon: Archive }] },
];

function General() {
  const t = useT();
  const app = useApp();
  return (
    <>
      <h1>{t("general")}</h1>
      <p className="lead">{t("generalLead")}</p>
      <div className="card">
        <SettingRow id="language" title={t("language")}>
          <div className="seg" role="group" aria-label={t("language")}>
            <button className={app.locale === "ru" ? "active" : ""} aria-pressed={app.locale === "ru"} lang="ru" onClick={() => app.setLocale("ru")}>Русский</button>
            <button className={app.locale === "en" ? "active" : ""} aria-pressed={app.locale === "en"} lang="en" onClick={() => app.setLocale("en")}>English</button>
          </div>
        </SettingRow>
        <SettingRow id="onboarding" title={t("onboarding")} description={t("onboardingDesc")}>
          <button className="btn-soft" onClick={() => app.setOnboarded(false)}>{t("runAgain")}</button>
        </SettingRow>
      </div>
      <AppearanceSettings />
      <UpdaterPanel />
    </>
  );
}

function StoragePage() {
  const t = useT();
  return (
    <>
      <h1>{t("cleanupTitle")}</h1>
      <p className="lead">{t("storageLead")}</p>
      <CleanupSettings />
    </>
  );
}

function WebPage() {
  const t = useT();
  return (
    <>
      <h1>{t("webTools")}</h1>
      <p className="lead">{t("webLead")}</p>
      <WebSettings />
    </>
  );
}

function ShortcutsPage() {
  const t = useT();
  return (
    <>
      <h1>{t("shortcuts")}</h1>
      <p className="lead">{t("shortcutsLead")}</p>
      <ShortcutsSettings />
    </>
  );
}

function ImportPage() {
  const t = useT();
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ImportRecord[]>([]);
  const load = () => getSetting<ImportRecord[]>("importHistory", []).then(setHistory);
  useEffect(() => void load(), []);
  return (
    <>
      <h1>{t("import")}</h1>
      <p className="lead">{t("importLead")}</p>
      <h4 aria-level={2}>{t("importFromApp")}</h4>
      <p className="h4-sub">{t("importFromAppSub")}</p>
      <div className="card">
        <div className="card-row">
          <span className="prov-icon"><MousePointer2 size={15} /></span>
          <div className="grow t">{t("importSources")}</div>
          <button className="btn-soft" onClick={() => setOpen(!open)}>{t("import")}</button>
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 12 }}>
          <ImportPanel onDone={() => (setOpen(false), load(), app.reload())} />
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <ChatTransfer />
      </div>
      <h4 aria-level={2}>{t("importHistory")}</h4>
      <div className="card">
        {!history.length && <div className="card-row d">{t("importHistoryEmpty")}</div>}
        {history.map((h, i) => (
          <div key={i} className="card-row">
            {h.source === "cursor" ? <MousePointer2 size={15} /> : <History size={15} />}
            <div className="grow">
              <div className="t">{t("importedFrom", { source: SOURCE_LABELS[h.source as keyof typeof SOURCE_LABELS] ?? h.source })}</div>
              <div className="d">{t.date(h.at)}</div>
            </div>
            <span className="d"><span className="status-dot" style={{ background: "var(--green)" }} />{t("chatsCount", { count: h.chats })}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Usage() {
  const t = useT();
  const app = useApp();
  const format = (n: number) => n.toLocaleString(app.locale);
  const dashboard = (p: ProviderConfig) => p.cli === "claude" ? "https://claude.ai/settings/usage" : p.cli === "codex" ? "https://chatgpt.com/codex/settings/usage" : p.cli === "cursor-agent" || p.kind === "cursor" ? "https://cursor.com/dashboard?tab=usage" : p.kind === "openrouter" ? "https://openrouter.ai/activity" : null;
  return <>
    <h1>{t("usage")}</h1><p className="lead">{t("tokenUsageLead")}</p>
    <BudgetsSection />
    <AgentSettingsSection />
    <h4 aria-level={2}>{t("providers")}</h4>
    {app.providers.map(p => {
      const stats = Object.values(app.tokenStats).filter(s => s.providerId === p.id);
      const total = stats.reduce((a,s) => ({ input: a.input + s.input, output: a.output + s.output, cached: a.cached + s.cached }), { input: 0, output: 0, cached: 0 });
      const snapshot = app.limits[p.id]; const link = dashboard(p);
      return <div className="card usage-card" key={p.id}>
        <div className="card-row"><ProviderIcon kind={p.kind} cli={p.cli} /><div className="grow t">{p.name}</div><span className="d">{t("requestsCount", { count: app.usage[p.id] ?? 0 })}</span></div>
        <div className="usage-metrics"><div><small>{t("inputTokens")}</small><strong>{stats.length ? format(total.input) : "—"}</strong></div><div><small>{t("outputTokens")}</small><strong>{stats.length ? format(total.output) : "—"}</strong></div><div><small>{t("cachedTokens")}</small><strong>{stats.length ? format(total.cached) : "—"}</strong></div></div>
        {!stats.length && <p className="d usage-note">{t("tokensUnavailable")}</p>}
        {stats.map(s => <div className="card-row" key={s.model}><ModelIcon model={s.model} provider={p} /><div className="grow"><div className="t">{app.models.find(m => m.providerId === p.id && m.id === s.model)?.name ?? s.model}{s.level && <span className="d" title={t("effortTitle")}> · {t(`reasoning_${s.level}`)}</span>}</div><div className="d">{t("reportedTurns", { count: s.turns })}</div></div><span className="d">{format(s.input)} ↓ · {format(s.output)} ↑</span></div>)}
        <div className="card-row"><div className="grow t">{t("subscriptionLimits")}</div>{p.cli === "codex" && <button className="btn-soft" disabled={!!app.loadingLimits} onClick={() => app.refreshLimits(p)}>{t(app.loadingLimits === p.id ? "providerChecking" : "refreshLimits")}</button>}{link && <button className="btn-soft" onClick={() => openUrl(link)}>{t("usageDashboard")}</button>}</div>
        {snapshot?.windows.length ? <div className="usage-limits">{snapshot.windows.map(w => <div key={w.id}><div className="usage-limit-label"><span>{w.label}{w.plan ? ` · ${w.plan}` : ""}</span><span>{Math.round(w.usedPercent)}% {t("used")}</span></div><progress max={100} value={w.usedPercent} aria-label={`${w.label}: ${Math.round(w.usedPercent)}% ${t("used")}`} />{w.resetsAt && <div className="d">{t("resetsAt")} {new Date(w.resetsAt * 1000).toLocaleString(app.locale)}</div>}</div>)}<p className="d">{t("usageCheckedAt")} {new Date(snapshot.checkedAt).toLocaleString(app.locale)}</p></div> : <p className="d usage-note">{t("limitsUnavailable")}</p>}
        {app.limitErrors[p.id] && <div className="error-box">{app.limitErrors[p.id]}</div>}
      </div>;
    })}
    {!app.providers.length && <p className="d">{t("noProviders")}</p>}
  </>;
}

function ComputerPage() {
  const t = useT();
  const app = useApp();
  const [perm, setPerm] = useState<{ accessibility: boolean; screen: boolean; supported?: boolean } | null>(null);
  const check = (request = false) => computer.permissions(request).then(setPerm);
  useEffect(() => {
    check();
    const i = setInterval(() => check(), 2000);
    return () => clearInterval(i);
  }, []);
  const row = (id: string, ok: boolean | undefined, title: Key, desc: Key, pane: string, request?: boolean) => (
    <SettingRow id={id} title={<><span className="status-dot" style={{ background: ok ? "var(--green)" : "var(--warn)" }} />{t(title)}</>} description={t(desc)}>
      {ok ? <span className="d ok">{t("granted")}</span> : (
        isMac() ? <button className="btn-soft" onClick={() => (request && check(true), openUrl(`x-apple.systempreferences:com.apple.preference.security?${pane}`))}>{t("openSettings")}</button> : <span className="d">{t("computerUnsupportedHere")}</span>
      )}
    </SettingRow>
  );
  return (
    <>
      <h1>{t("computerUse")}</h1>
      <p className="lead">{t("computerLead")}</p>
      <h4 aria-level={2}>{t("permissions")}</h4>
      <div className="card">
        {row("permAccessibility", perm?.accessibility, "permAccessibility", "permAccessibilityDesc", "Privacy_Accessibility")}
        {row("permScreen", perm?.screen, "permScreen", "permScreenDesc", "Privacy_ScreenCapture", true)}
      </div>
      <h4 aria-level={2}>{t("behavior")}</h4>
      <div className="card">
        <SettingRow id="computerEnable" title={t("computerEnable")} description={t("computerEnableDesc")} toggle={{ on: app.computerUse, onChange: (v) => app.setComputerUse(v && !!perm?.accessibility && !!perm?.screen) }} />
        <SettingRow id="computerSafety" title={t("computerSafety")} description={t("computerSafetyDesc", { mod: displayKeys("⌘").replace(/\+$/, ""), stop: shortcutDisplay(shortcut("stopAgent")) })} />
      </div>
    </>
  );
}

function GitPage() {
  const t = useT();
  const app = useApp();
  return (
    <>
      <h1>{t("gitAndCommands")}</h1>
      <p className="lead">{t("gitLead")}</p>
      <div className="card">
        <SettingRow id="reviewCopy" title={t("reviewCopySetting")} description={t("reviewCopySettingDesc")} toggle={{ on: app.reviewCopy === true, onChange: app.setReviewCopy }} />
      </div>
      <AutoReviewSettings />
      <CommandRules />
      <DiagnosticsSettings /><SemanticSettings /><HooksSettings />
      <VerificationSettings />
    </>
  );
}

function Rules() {
  const t = useT();
  const app = useApp();
  const withPath = app.projects.filter((p) => p.path);
  const [pid, setPid] = useState(withPath[0]?.id);
  const [rules, setRules] = useState("");
  const path = withPath.find((p) => p.id === pid)?.path;
  useEffect(() => {
    if (path) loadProjectInstructions({ root: path, project: path }).then((r) => setRules(r.text));
  }, [path]);
  return (
    <>
      <h1>{t("rules")}</h1>
      <p className="lead">{t("rulesLead")}</p>
      <select aria-label={t("searchProject")} className="input" value={pid} onChange={(e) => setPid(Number(e.target.value))} style={{ marginBottom: 12 }}>
        {withPath.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="card" style={{ padding: 14 }}>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-2)", userSelect: "text" }}>{rules || t("rulesNone")}</pre>
      </div>
    </>
  );
}

function ArchivePage() {
  const t = useT();
  const app = useApp();
  const [list, setList] = useState<Chat[]>([]);
  const load = () => listArchived().then(setList);
  useEffect(() => void load(), []);
  return (
    <>
      <h1>{t("archivedChats")}</h1>
      <p className="lead">{t("archiveLead")}</p>
      <div className="card">
        {!list.length && <div className="card-row d">{t("archiveEmpty")}</div>}
        {list.map((c) => (
          <div key={c.id} className="card-row">
            <div className="grow">
              <div className="t">{c.title}</div>
              <div className="d">{t.date(c.updated_at)}</div>
            </div>
            <button className="btn-soft" onClick={async () => (await archiveChat(c.id, false), load(), app.reload())}>
              <Undo2 size={13} /> {t("unarchive")}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/** Scrolls to the row a settings search result points at (`data-setting`) and flashes it; waits briefly for pages that load their rows later. */
function useSettingTarget() {
  const app = useApp();
  const target = app.settingTarget;
  const clear = useRef(app.clearSettingTarget);
  clear.current = app.clearSettingTarget;
  useEffect(() => {
    if (!target) return;
    let tries = 0;
    let flash: ReturnType<typeof setTimeout> | undefined;
    const find = () => {
      const el = document.querySelector<HTMLElement>(`[data-setting="${target}"]`);
      if (!el) return false;
      el.scrollIntoView?.({ block: "center" });
      el.classList.add("setting-hit");
      flash = setTimeout(() => el.classList.remove("setting-hit"), 2600);
      clear.current();
      return true;
    };
    if (find()) return () => clearTimeout(flash);
    const timer = setInterval(() => {
      if (find()) clearInterval(timer);
      else if (++tries > 20) { clearInterval(timer); clear.current(); }
    }, 100);
    return () => { clearInterval(timer); clearTimeout(flash); };
  }, [target, app.settingsPage]);
}

const PAGES: Record<SettingsPage, () => React.JSX.Element> = {
  memory: MemorySettings, storage: StoragePage, web: WebPage, general: General, shortcuts: ShortcutsPage, import: ImportPage, providers: ProvidersPage, usage: Usage, computer: ComputerPage, mcp: McpServers, scheduled: ScheduledPage, git: GitPage, rules: Rules, archive: ArchivePage, knowledge: KnowledgeSettings, mobile: MobileSettings, diagnostics: AppDiagnostics,
};

export function Settings() {
  const t = useT();
  const app = useApp();
  const Page = PAGES[app.settingsPage];
  const [searching, setSearching] = useState(false);
  useSettingTarget();
  return (
    <div className="settings">
      <nav className="settings-nav drag" aria-label={t("settings")}>
        <div className="settings-nav-title">{t("settings")}</div>
        <SettingsSearch onActive={setSearching} />
        {!searching && NAV.map((g) => (
          <div key={g.group} role="group" aria-label={t(g.group)}>
            <div className="section-title" aria-hidden="true" style={{ paddingTop: 10 }}>{t(g.group)}</div>
            {g.items.map((it) => (
              <button key={it.id} className={`row${app.settingsPage === it.id ? " active" : ""}`} aria-current={app.settingsPage === it.id ? "page" : undefined} onClick={() => app.openSettings(it.id)}>
                <it.icon size={15} />
                <span className="label">{t(it.label)}</span>
              </button>
            ))}
          </div>
        ))}
        {!searching && <button className="row muted" style={{ marginTop: 12 }} onClick={() => openUrl("https://developers.openai.com/api/docs/guides/tools-computer-use")}>
          <span className="label">{t("docs")}</span>
        </button>}
      </nav>
      <main className="settings-main" aria-label={t(NAV.flatMap((g) => g.items).find((it) => it.id === app.settingsPage)?.label ?? "settings")}>
        <div className="drag" style={{ height: 0 }} />
        <div className={`settings-inner${app.settingsPage === "providers" ? " wide" : ""}`}>
          <Page />
        </div>
      </main>
    </div>
  );
}
