import { SemanticSettings } from "./SemanticSettings";
import { VoiceSettings } from "./VoiceSettings";
import { WebSettings } from "./WebSettings";
import { UpdaterPanel } from "./UpdaterPanel";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Archive, BarChart3, Smartphone, Clock, Download, FileText, GitBranch, History, Monitor, MousePointer2, Plug, Plus, RefreshCw, Settings as Gear, Star, Trash2, Undo2, Boxes,
} from "lucide-react";
import { useEffect, useState } from "react";
import { loadProjectInstructions } from "../agent/instructionsStore";
import { useT, type Key } from "../i18n";
import { displayKeys, isMac } from "../lib/platform";
import { shortcut, shortcutDisplay } from "../lib/shortcuts";
import { computer, getSetting } from "../lib/api";
import { archiveChat, listArchived, type Chat, type ImportRecord } from "../lib/data";
import { SOURCE_LABELS } from "../lib/importers/common";
import { deleteProvider, PRESETS, saveProvider } from "../providers";
import { cliName, detectClis } from "../providers/cli";
import type { CliId, ProviderConfig } from "../providers/types";
import { modelKey, useApp, type SettingsPage } from "../state";
import { DiagnosticsSettings } from "./DiagnosticsSettings";
import { MemorySettings } from "./MemorySettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { BudgetsSection } from "./Budgets";
import { AgentSettingsSection } from "./AgentSettingsSection";
import { CommandRules } from "./CommandRules";
import { HooksSettings } from "./HooksSettings";
import { CursorAccounts } from "./CursorAccounts";
import { ChatTransfer, ImportPanel } from "./ImportPanel";
import { McpServers } from "./McpServers";
import { MobileSettings } from "./MobileSettings";
import { ProviderForm } from "./ProviderForm";
import { ModelIcon } from "./ModelIcon";
import { ProviderIcon } from "./ProviderIcon";
import { ScheduledPage } from "./ScheduledPromptsSection";
import { ShortcutsSettings } from "./ShortcutsSettings";

const NAV: { group: Key; items: { id: SettingsPage; label: Key; icon: typeof Gear }[] }[] = [
  {
    group: "personal",
    items: [
      { id: "general", label: "general", icon: Gear },
      { id: "import", label: "import", icon: Download },
      { id: "providers", label: "providers", icon: Boxes },
      { id: "usage", label: "usage", icon: BarChart3 },
      { id: "memory", label: "memoryTitle", icon: FileText },
    ],
  },
  { group: "integrations", items: [{ id: "computer", label: "computerUse", icon: Monitor }, { id: "mcp", label: "mcp", icon: Plug }, { id: "scheduled", label: "scheduledNav", icon: Clock }, { id: "mobile", label: "mobileTitle", icon: Smartphone }] },
  { group: "code", items: [{ id: "git", label: "gitAndCommands", icon: GitBranch }, { id: "rules", label: "rules", icon: FileText }] },
  { group: "archiveGroup", items: [{ id: "archive", label: "archivedChats", icon: Archive }] },
];

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

function General() {
  const t = useT();
  const app = useApp();
  return (
    <>
      <h1>{t("general")}</h1>
      <p className="lead">{t("generalLead")}</p>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("language")}</div>
          </div>
          <div className="seg" role="group" aria-label={t("language")} style={{ margin: 0 }}>
            <button className={app.locale === "ru" ? "active" : ""} aria-pressed={app.locale === "ru"} lang="ru" onClick={() => app.setLocale("ru")}>Русский</button>
            <button className={app.locale === "en" ? "active" : ""} aria-pressed={app.locale === "en"} lang="en" onClick={() => app.setLocale("en")}>English</button>
          </div>
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("onboarding")}</div>
            <div className="d">{t("onboardingDesc")}</div>
          </div>
          <button className="btn-soft" onClick={() => app.setOnboarded(false)}>{t("runAgain")}</button>
        </div>
      </div>
      <AppearanceSettings />
      <ShortcutsSettings />
      <DeveloperSettings />
    <VoiceSettings /><WebSettings /><UpdaterPanel /></>
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

function Providers() {
  const t = useT();
  const app = useApp();
  const [clis, setClis] = useState<{ id: CliId; version: string }[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void detectClis().then(setClis, () => {}), []);

  const pending = clis.filter((c) => !app.providers.some((p) => p.cli === c.id));
  const current = sel ?? app.providers[0]?.id ?? (pending[0] ? `cli:${pending[0].id}` : "new");
  const prov = app.providers.find((p) => p.id === current);
  const pendingCli = pending.find((c) => `cli:${c.id}` === current);
  const short = (v: string) => /\d+(?:\.\d+)+/.exec(v)?.[0] ?? v.split(/[\s-]/)[0];
  const version = (p: ProviderConfig) => {
    const v = clis.find((c) => c.id === p.cli)?.version;
    return v && short(v);
  };

  const refresh = async () => (setBusy(true), await app.refreshModels().finally(() => setBusy(false)));
  // Only a new key, base URL or re-enabling refetches that provider's models; a rename keeps the cached list (no Keychain read).
  const update = async (p: ProviderConfig, key: string | null = null) => {
    const old = app.providers.find((x) => x.id === p.id);
    await saveProvider(p, key);
    const refetch = key !== null || !old || old.baseUrl !== p.baseUrl || (!!old.disabled && !p.disabled);
    setBusy(true);
    await app.refreshModels(refetch ? { only: [p.id] } : { refresh: "startup" }).finally(() => setBusy(false));
  };
  const connect = async (id: CliId) => {
    const c: ProviderConfig = { id: `cli-${id}-${Date.now().toString(36)}`, kind: "cli", name: cliName(id), baseUrl: "", cli: id };
    await update(c);
    setSel(c.id);
  };

  const status = (p: ProviderConfig) => {
    if (p.disabled) return <span className="d">{t("providerOff")}</span>;
    const health = app.providerHealth[p.id];
    if (health?.status === "auth") return <span className="err" title={health.message}>{t("providerAuth")}</span>;
    const err = health?.status === "error" ? health.message : app.modelErrors[p.id];
    if (err) return <span className="err" title={err}><span className="status-dot" style={{ background: "var(--red)" }} />{err.slice(0, 60)}</span>;
    return <span className="d"><span className="status-dot" style={{ background: health?.status === "ok" ? "var(--green)" : "var(--text-3)" }} />{t(health?.status === "ok" ? "providerOn" : "providerAvailable")} · {t("modelsCount", { count: app.models.filter((m) => m.providerId === p.id).length })}</span>;
  };

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1>{t("providers")}</h1>
          <p className="lead">{t("providersLead")}</p>
        </div>
        <button className="btn-ghost small" onClick={refresh} disabled={busy}>
          <RefreshCw size={13} className={busy ? "spin" : ""} /> {app.checkedAt ? t("checkedAt", { time: new Date(app.checkedAt).toLocaleTimeString(app.locale, { hour: "2-digit", minute: "2-digit" }) }) : t("checkNow")}
        </button>
      </div>
      <div className="split card">
        <div className="split-list">
          {app.providers.map((p) => (
            <div key={p.id} className={`split-item${current === p.id ? " active" : ""}`}>
              <button className="split-main" aria-current={current === p.id ? "true" : undefined} onClick={() => setSel(p.id)}>
                <ProviderIcon kind={p.kind} cli={p.cli} />
                <div className="grow">
                  <div className="t">{p.name} {version(p) && <span className="mono d">v{version(p)}</span>}</div>
                  <div className="sub">{status(p)}</div>
                </div>
              </button>
              <Toggle on={!p.disabled} label={p.name} onChange={(on) => update({ ...p, disabled: !on })} />
            </div>
          ))}
          {pending.map((c) => (
            <div key={c.id} className={`split-item${current === `cli:${c.id}` ? " active" : ""}`}>
              <button className="split-main" aria-current={current === `cli:${c.id}` ? "true" : undefined} onClick={() => setSel(`cli:${c.id}`)}>
                <ProviderIcon kind="cli" cli={c.id} />
                <div className="grow">
                  <div className="t">{cliName(c.id)} <span className="mono d">v{short(c.version)}</span></div>
                  <div className="sub d">{t("notConnected")}</div>
                </div>
              </button>
              <Toggle on={false} label={cliName(c.id)} onChange={() => connect(c.id)} />
            </div>
          ))}
          <button className={`split-item add${current === "new" ? " active" : ""}`} aria-current={current === "new" ? "true" : undefined} onClick={() => setSel("new")}>
            <Plus size={15} /> <span className="grow">{t("addProvider")}</span>
          </button>
        </div>
        <div className="split-detail">
          {current === "new" && (
            <ProviderForm
              onCancel={app.providers[0] ? () => setSel(null) : undefined}
              onSaved={async (cfg, models) => {
                await app.refreshModels({ only: [cfg.id] });
                setSel(cfg.id);
                if (!app.selection && models[0]) app.setSelection({ providerId: cfg.id, model: models[0].id });
              }}
            />
          )}
          {pendingCli && (
            <div className="card">
              <div className="card-row">
                <div className="grow">
                  <div className="t">{cliName(pendingCli.id)}</div>
                  <div className="d">{t("cliFound")}</div>
                </div>
                <button className="btn-soft" disabled={busy} onClick={() => connect(pendingCli.id)}>{t("cliConnect")}</button>
              </div>
            </div>
          )}
          {prov && <ProviderDetail key={prov.id} p={prov} update={update} />}
        </div>
      </div>
    </>
  );
}

function ProviderDetail({ p, update }: { p: ProviderConfig; update: (p: ProviderConfig, key?: string | null) => Promise<unknown> }) {
  const t = useT();
  const app = useApp();
  const [name, setName] = useState(p.name);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [key, setKey] = useState("");
  const [q, setQ] = useState("");
  const models = app.models.filter((m) => m.providerId === p.id);
  const shown = models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  const keys = models.map(modelKey);
  const allHidden = keys.length > 0 && keys.every((k) => app.hiddenModels.includes(k));
  const toggle = (list: string[], k: string, on: boolean) => (on ? [...list, k] : list.filter((x) => x !== k));

  return (
    <>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("displayName")}</div>
            <div className="d">{p.kind === "cli" ? t("cliSubscription") : PRESETS[p.kind].name}</div>
          </div>
          <input aria-label={t("displayName")} className="input narrow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== p.name && update({ ...p, name: name.trim() })} />
          <button className="icon-btn" title={t("delete")} aria-label={t("delete")} onClick={async () => (await deleteProvider(p.id), app.refreshModels({ refresh: "startup" }))}><Trash2 size={14} /></button>
        </div>
      </div>
      <div className="card"><div className="card-row"><div className="grow"><div className="t">{t(app.providerHealth[p.id]?.status === "auth" ? "providerAuth" : app.providerHealth[p.id]?.status === "ok" ? "providerOn" : "providerAvailable")}</div><div className="d">{t("providerCheckHint")}</div>
      {app.providerHealth[p.id]?.message && <div className="err" style={{ whiteSpace: "pre-wrap" }}>{app.providerHealth[p.id].message}</div>}
      {app.providerHealth[p.id]?.status === "auth" && p.kind === "cli" && <code>{p.cli === "claude" ? "claude auth login" : p.cli === "cursor-agent" ? "cursor-agent login" : "codex login"}</code>}
      </div><button className="btn-soft" disabled={!!app.checkingProvider || p.disabled} onClick={() => app.checkProvider(p)}>{t(app.checkingProvider === p.id ? "providerChecking" : "providerCheck")}</button></div></div>
      <h4 aria-level={2}>{t("runtime")}</h4>
      <div className="card">
        {p.kind === "cli" ? (
          <div className="card-row">
            <div className="grow">
              <div className="t">{t("command")}</div>
              <div className="d">{t("cliCommandHint")}</div>
            </div>
            <code className="mono">{p.cli}</code>
          </div>
        ) : (
          <>
            {p.kind !== "cursor" && (
              <div className="card-row">
                <div className="grow t">Base URL</div>
                <input aria-label="Base URL" className="input narrow" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => baseUrl !== p.baseUrl && update({ ...p, baseUrl: baseUrl.trim() })} />
              </div>
            )}
            <div className="card-row">
              <div className="grow">
                <div className="t">{t("apiKey")}</div>
                <div className="d">{t("keyUnchanged")}</div>
              </div>
              <input aria-label={t("apiKey")} className="input narrow" type="password" placeholder="••••••••" value={key} onChange={(e) => setKey(e.target.value)} onBlur={() => key.trim() && update(p, key.trim()).then(() => setKey(""))} />
            </div>
          </>
        )}
      </div>
      {p.cli === "cursor-agent" && <>
        {p.cliAuth === "key" && <div className="card"><div className="card-row"><div className="grow"><div className="t">{t("apiKey")}</div><div className="d">{t("cursorCliAccountHint")}</div></div><input aria-label={t("apiKey")} className="input narrow" type="password" placeholder={t("keyUnchanged")} value={key} onChange={e => setKey(e.target.value)} /><button className="btn-soft" disabled={!key.trim()} onClick={() => update(p, key.trim()).then(() => setKey(""))}>{t("save")}</button></div></div>}
        <CursorAccounts />
      </>}
      <h4 aria-level={2}>{t("models")}</h4>
      <div className="card">
        <div className="card-row" style={{ minHeight: 44 }}>
          <input aria-label={t("searchModels")} className="input narrow" placeholder={t("searchModels")} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn-ghost small" onClick={() => app.setHiddenModels(allHidden ? app.hiddenModels.filter((k) => !keys.includes(k)) : [...new Set([...app.hiddenModels, ...keys])])}>
            {t(allHidden ? "showAll" : "hideAll")}
          </button>
          <span className="grow d">{t("modelsCount", { count: models.length })}</span>
        </div>
        <div className="model-table">
          {shown.map((m) => {
            const k = modelKey(m);
            const fav = app.favorites.includes(k);
            return (
              <div key={m.id} className="model-line">
                <button className={`star${fav ? " on" : ""}`} title={t("favorite")} aria-label={`${t("favorite")}: ${m.name}`} aria-pressed={fav} onClick={() => app.setFavorites(toggle(app.favorites, k, !fav))}>
                  <Star size={13} fill={fav ? "currentColor" : "none"} />
                </button>
                <span className="grow">{m.name} {m.name !== m.id && <span className="mono d">{m.id}</span>}</span>
                <Toggle on={!app.hiddenModels.includes(k)} label={m.name} onChange={(on) => app.setHiddenModels(toggle(app.hiddenModels, k, !on))} />
              </div>
            );
          })}
          {!shown.length && <div className="card-row d">{app.modelErrors[p.id] ?? t("noModels")}</div>}
        </div>
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
        {stats.map(s => <div className="card-row" key={s.model}><ModelIcon model={s.model} provider={p} /><div className="grow"><div className="t">{app.models.find(m => m.providerId === p.id && m.id === s.model)?.name ?? s.model}</div><div className="d">{t("reportedTurns", { count: s.turns })}</div></div><span className="d">{format(s.input)} ↓ · {format(s.output)} ↑</span></div>)}
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
  const row = (ok: boolean | undefined, title: Key, desc: Key, pane: string, request?: boolean) => (
    <div className="card-row">
      <div className="grow">
        <div className="t"><span className="status-dot" style={{ background: ok ? "var(--green)" : "var(--warn)" }} />{t(title)}</div>
        <div className="d">{t(desc)}</div>
      </div>
      {ok ? <span className="d ok">{t("granted")}</span> : (
        isMac() ? <button className="btn-soft" onClick={() => (request && check(true), openUrl(`x-apple.systempreferences:com.apple.preference.security?${pane}`))}>{t("openSettings")}</button> : <span className="d">{t("computerUnsupportedHere")}</span>
      )}
    </div>
  );
  return (
    <>
      <h1>{t("computerUse")}</h1>
      <p className="lead">{t("computerLead")}</p>
      <h4 aria-level={2}>{t("permissions")}</h4>
      <div className="card">
        {row(perm?.accessibility, "permAccessibility", "permAccessibilityDesc", "Privacy_Accessibility")}
        {row(perm?.screen, "permScreen", "permScreenDesc", "Privacy_ScreenCapture", true)}
      </div>
      <h4 aria-level={2}>{t("behavior")}</h4>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("computerEnable")}</div>
            <div className="d">{t("computerEnableDesc")}</div>
          </div>
          <Toggle on={app.computerUse} label={t("computerUse")} onChange={(v) => app.setComputerUse(v && !!perm?.accessibility && !!perm?.screen)} />
        </div>
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("computerSafety")}</div>
            <div className="d">{t("computerSafetyDesc", { mod: displayKeys("⌘").replace(/\+$/, ""), stop: shortcutDisplay(shortcut("stopAgent")) })}</div>
          </div>
        </div>
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
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("reviewCopySetting")}</div>
            <div className="d">{t("reviewCopySettingDesc")}</div>
          </div>
          <Toggle on={app.reviewCopy === true} label={t("reviewCopySetting")} onChange={app.setReviewCopy} />
        </div>
      </div>
      <CommandRules />
      <DiagnosticsSettings /><SemanticSettings /><HooksSettings />
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

const PAGES: Record<SettingsPage, () => React.JSX.Element> = {
  memory: MemorySettings, general: General, import: ImportPage, providers: Providers, usage: Usage, computer: ComputerPage, mcp: McpServers, scheduled: ScheduledPage, git: GitPage, rules: Rules, archive: ArchivePage, mobile: MobileSettings,
};

export function Settings() {
  const t = useT();
  const app = useApp();
  const Page = PAGES[app.settingsPage];
  return (
    <div className="settings">
      <nav className="settings-nav drag" aria-label={t("settings")}>
        <div className="settings-nav-title">{t("settings")}</div>
        {NAV.map((g) => (
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
        <button className="row muted" style={{ marginTop: 12 }} onClick={() => openUrl("https://developers.openai.com/api/docs/guides/tools-computer-use")}>
          <span className="label">{t("docs")}</span>
        </button>
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
