import { Copy, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { deleteProvider, PRESETS, saveProvider } from "../providers";
import { cliName, detectClis } from "../providers/cli";
import { driverOf, DRIVER_NAMES, orderProviders, PINNED, type Driver } from "../providers/drivers";
import type { CliId, ProviderConfig, ProviderKind } from "../providers/types";
import { modelKey, useApp } from "../state";
import { AddProviderDialog, type TileId } from "./AddProviderDialog";
import { CursorAccounts } from "./CursorAccounts";
import { ProviderIcon } from "./ProviderIcon";

type Clis = { id: CliId; version: string }[];
type Row = { key: string; driver: Driver | null; p?: ProviderConfig };

const DRIVER_KIND: Record<Driver, ProviderKind> = { claude: "anthropic", codex: "openai", cursor: "cursor", grok: "xai" };
const DRIVER_CLI: Partial<Record<Driver, CliId>> = { claude: "claude", codex: "codex", cursor: "cursor-agent" };
const short = (v: string) => /\d+(?:\.\d+)+/.exec(v)?.[0] ?? v.split(/[\s-]/)[0];
const signInCommand = (cli?: CliId) => (cli === "claude" ? "claude auth login" : cli === "cursor-agent" ? "cursor-agent login" : "codex login");

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`toggle${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** Status of a provider from cached data only (last check, last model listing): opening the page sends nothing and reads no key. */
function useStatus() {
  const t = useT();
  const app = useApp();
  return (p: ProviderConfig): { color: string; label: string; detail: string; tone: "ok" | "warn" | "err" | "muted" } => {
    const count = t("modelsCount", { count: app.models.filter((m) => m.providerId === p.id).length });
    if (p.disabled) return { color: "var(--text-3)", label: t("providerOff"), detail: "", tone: "muted" };
    const health = app.providerHealth[p.id];
    if (health?.status === "auth") return { color: "var(--yellow, #d9a33b)", label: t("provNotAuthenticated"), detail: health.message, tone: "warn" };
    const err = health?.status === "error" ? health.message : app.modelErrors[p.id];
    if (err) return { color: "var(--red)", label: t("provUnavailable"), detail: err, tone: "err" };
    if (health?.status === "ok") {
      const plan = app.limits?.[p.id]?.windows.find((w) => w.plan)?.plan;
      return { color: "var(--green)", label: t("provAuthenticated"), detail: plan ?? count, tone: "ok" };
    }
    return { color: "var(--text-3)", label: t("provNotChecked"), detail: count, tone: "muted" };
  };
}

/**
 * Settings, Model providers: pinned drivers (Claude, GPT / Codex, Cursor, Grok) always on the left, each configured
 * instance as its own row, then every other provider; the selected row's details on the right; "+" opens the wizard.
 */
export function ProvidersPage() {
  const t = useT();
  const app = useApp();
  const status = useStatus();
  const [clis, setClis] = useState<Clis>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ tile?: TileId } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => void detectClis().then(setClis, () => {}), []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const ordered = orderProviders(app.providers);
  const rows: Row[] = [
    ...PINNED.flatMap((d): Row[] => {
      const own = ordered.filter((p) => driverOf(p) === d);
      return own.length ? own.map((p) => ({ key: p.id, driver: d, p })) : [{ key: `driver:${d}`, driver: d }];
    }),
    ...ordered.filter((p) => !driverOf(p)).map((p) => ({ key: p.id, driver: null, p })),
  ];
  const current = rows.find((r) => r.key === sel) ?? rows.find((r) => r.p) ?? rows[0];
  const version = (cli?: CliId) => {
    const v = cli && clis.find((c) => c.id === cli)?.version;
    return v ? short(v) : undefined;
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
  const connectCli = async (id: CliId) => {
    const c: ProviderConfig = { id: `cli-${id}-${Date.now().toString(36)}`, kind: "cli", name: cliName(id), baseUrl: "", cli: id };
    await update(c);
    setSel(c.id);
  };
  const minutes = app.checkedAt ? Math.floor((now - app.checkedAt) / 60_000) : -1;

  return (
    <>
      <div className="page-head">
        <div className="grow">
          <h1>{t("providers")}</h1>
          <p className="lead">{t("providersLead")}</p>
        </div>
        <button className="btn-ghost small" onClick={refresh} disabled={busy} title={t("checkNow")}>
          <RefreshCw size={13} className={busy ? "spin" : ""} /> {minutes < 0 ? t("checkNow") : minutes < 1 ? t("provCheckedJustNow") : t("provCheckedMin", { count: minutes })}
        </button>
        <button className="icon-btn" title={t("addProvider")} aria-label={t("addProvider")} onClick={() => setAdding({})}>
          <Plus size={15} />
        </button>
      </div>
      <div className="split card providers-split">
        <div className="split-list" role="list" aria-label={t("providers")}>
          {rows.map((r) => {
            const active = current.key === r.key;
            if (!r.p) {
              const d = r.driver!;
              return (
                <div key={r.key} role="listitem" className={`split-item unset${active ? " active" : ""}`}>
                  <button className="split-main" aria-current={active ? "true" : undefined} onClick={() => setSel(r.key)}>
                    <ProviderIcon kind={DRIVER_KIND[d]} cli={DRIVER_CLI[d]} />
                    <div className="grow">
                      <div className="t">{DRIVER_NAMES[d]} {version(DRIVER_CLI[d]) && <span className="mono d">v{version(DRIVER_CLI[d])}</span>}</div>
                      <div className="sub d">{t("provNotSetUp")} · <span className="link">{t("provConnect")}</span></div>
                    </div>
                  </button>
                </div>
              );
            }
            const p = r.p;
            const s = status(p);
            const v = p.kind === "cli" ? version(p.cli) : undefined;
            return (
              <div key={r.key} role="listitem" className={`split-item${active ? " active" : ""}`} data-tone={s.tone}>
                <button className="split-main" aria-current={active ? "true" : undefined} onClick={() => setSel(r.key)}>
                  <ProviderIcon kind={p.kind} cli={p.cli} />
                  <div className="grow">
                    <div className="t">{p.name} {v && <span className="mono d">v{v}</span>}</div>
                    <div className={`sub ${s.tone === "err" || s.tone === "warn" ? "err" : "d"}`} title={s.detail || undefined}>
                      <span className="status-dot" style={{ background: s.color }} />
                      {s.label}{s.detail ? ` · ${s.detail.slice(0, 80)}` : ""}
                    </div>
                  </div>
                </button>
                <Toggle on={!p.disabled} label={p.name} onChange={(on) => update({ ...p, disabled: !on })} />
              </div>
            );
          })}
        </div>
        <div className="split-detail">
          {current.p ? (
            <ProviderDetail key={current.p.id} p={current.p} version={current.p.kind === "cli" ? version(current.p.cli) : undefined} update={update}
              onDuplicate={async (copy) => (await update(copy), setSel(copy.id))}
              onDeleted={() => setSel(null)} />
          ) : (
            <UnsetDriver driver={current.driver!} cli={DRIVER_CLI[current.driver!]} version={version(DRIVER_CLI[current.driver!])} busy={busy}
              onConnectCli={connectCli} onAdd={() => setAdding({ tile: current.driver! })} />
          )}
        </div>
      </div>
      {adding && (
        <AddProviderDialog initialTile={adding.tile} clis={clis} onClose={() => setAdding(null)}
          onSaved={async (cfg, models) => {
            setAdding(null);
            await app.refreshModels({ only: [cfg.id] });
            setSel(cfg.id);
            if (!app.selection && models[0]) app.setSelection({ providerId: cfg.id, model: models[0].id });
          }} />
      )}
    </>
  );
}

function UnsetDriver({ driver, cli, version, busy, onConnectCli, onAdd }: { driver: Driver; cli?: CliId; version?: string; busy: boolean; onConnectCli: (id: CliId) => void; onAdd: () => void }) {
  const t = useT();
  return (
    <>
      <div className="detail-head">
        <ProviderIcon kind={DRIVER_KIND[driver]} cli={cli} size={22} />
        <h3 className="grow">{DRIVER_NAMES[driver]}</h3>
      </div>
      <p className="d">{t("provUnsetLead", { name: DRIVER_NAMES[driver] })} {t(`provAbout_${driver}`)}</p>
      {cli && (
        <div className="card">
          <div className="card-row">
            <div className="grow">
              <div className="t">{cliName(cli)} CLI</div>
              <div className="d">{version ? t("provCliFound", { version }) : t("provCliMissing")}</div>
            </div>
            <button className="btn-soft" disabled={busy || !version} onClick={() => onConnectCli(cli)}>{t("cliConnect")}</button>
          </div>
        </div>
      )}
      <div className="dialog-foot" style={{ justifyContent: "flex-start" }}>
        <button className="btn btn-primary" onClick={onAdd}><Plus size={13} /> {t("addProvider")}</button>
      </div>
    </>
  );
}

function ProviderDetail({ p, version, update, onDuplicate, onDeleted }: { p: ProviderConfig; version?: string; update: (p: ProviderConfig, key?: string | null) => Promise<unknown>; onDuplicate: (copy: ProviderConfig) => void; onDeleted: () => void }) {
  const t = useT();
  const app = useApp();
  const [name, setName] = useState(p.name);
  const [baseUrl, setBaseUrl] = useState(p.baseUrl);
  const [key, setKey] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const models = app.models.filter((m) => m.providerId === p.id);
  const shown = models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q.trim().toLowerCase()));
  const keys = models.map(modelKey);
  const allHidden = keys.length > 0 && keys.every((k) => app.hiddenModels.includes(k));
  const toggle = (list: string[], k: string, on: boolean) => (on ? [...list, k] : list.filter((x) => x !== k));
  const health = app.providerHealth[p.id];
  const driver = driverOf(p);
  // The copy gets a new id and no key (copying would mean reading the Keychain); a browser-login Cursor account owns its profile folder, so it is not duplicated.
  const duplicate = () => {
    const { cliProfile: _profile, backupProviderId: _backup, ...rest } = p;
    onDuplicate({ ...rest, id: `${p.kind === "cli" ? `cli-${p.cli}` : p.kind}-${Date.now().toString(36)}`, name: t("provCopyName", { name: p.name }) });
  };
  const refreshModels = async () => {
    setLoading(true);
    await app.refreshModels({ only: [p.id] }).finally(() => setLoading(false));
  };

  return (
    <>
      <div className="detail-head">
        <ProviderIcon kind={p.kind} cli={p.cli} size={22} />
        <h3 className="grow">{p.name} {version && <span className="mono d">v{version}</span>}</h3>
        {!p.cliProfile && <button className="icon-btn" title={t("provDuplicate")} aria-label={t("provDuplicate")} onClick={duplicate}><Copy size={14} /></button>}
        <button className="icon-btn" title={t("delete")} aria-label={t("delete")} onClick={async () => (await deleteProvider(p.id), await app.refreshModels({ refresh: "startup" }), onDeleted())}><Trash2 size={14} /></button>
      </div>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t("displayName")}</div>
            <div className="d">{p.kind === "cli" ? t("cliSubscription") : PRESETS[p.kind].name}</div>
          </div>
          <input aria-label={t("displayName")} className="input narrow" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== p.name && update({ ...p, name: name.trim() })} />
        </div>
      </div>
      <div className="card">
        <div className="card-row">
          <div className="grow">
            <div className="t">{t(health?.status === "auth" ? "provNotAuthenticated" : health?.status === "ok" ? "provAuthenticated" : health?.status === "error" ? "provUnavailable" : "provNotChecked")}</div>
            <div className="d">{t("providerCheckHint")}</div>
            {health?.message && <div className="err" style={{ whiteSpace: "pre-wrap" }}>{health.message}</div>}
            {health?.status === "auth" && p.kind === "cli" && <div className="d">{t("provSignInCommand", { command: signInCommand(p.cli) })}</div>}
          </div>
          <button className="btn-soft" disabled={!!app.checkingProvider || p.disabled} onClick={() => app.checkProvider(p)}>{t(app.checkingProvider === p.id ? "providerChecking" : "providerCheck")}</button>
        </div>
      </div>
      <h4 aria-level={2}>{t("runtime")}</h4>
      <div className="card">
        {p.kind === "cli" ? (
          <>
            <div className="card-row">
              <div className="grow">
                <div className="t">{t("command")}</div>
                <div className="d">{t("cliCommandHint")}</div>
              </div>
              <code className="mono">{p.cli}</code>
            </div>
            {p.cliAuth === "key" && (
              <div className="card-row">
                <div className="grow">
                  <div className="t">{t("apiKey")}</div>
                  <div className="d">{t("cursorCliAccountHint")}</div>
                </div>
                <input aria-label={t("apiKey")} className="input narrow" type="password" placeholder={t("keyUnchanged")} value={key} onChange={(e) => setKey(e.target.value)} />
                <button className="btn-soft" disabled={!key.trim()} onClick={() => update(p, key.trim()).then(() => setKey(""))}>{t("save")}</button>
              </div>
            )}
          </>
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
      {driver === "cursor" && <CursorAccounts />}
      <h4 aria-level={2}>{t("models")}</h4>
      <div className="card">
        <div className="card-row" style={{ minHeight: 44 }}>
          <input aria-label={t("searchModels")} className="input narrow" placeholder={t("searchModels")} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn-ghost small" onClick={() => app.setHiddenModels(allHidden ? app.hiddenModels.filter((k) => !keys.includes(k)) : [...new Set([...app.hiddenModels, ...keys])])}>
            {t(allHidden ? "showAll" : "hideAll")}
          </button>
          <span className="grow d">{t("modelsCount", { count: models.length })}</span>
          <button className="btn-ghost small" disabled={loading || p.disabled} onClick={refreshModels}>
            <RefreshCw size={13} className={loading ? "spin" : ""} /> {t("provRefreshModels")}
          </button>
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
