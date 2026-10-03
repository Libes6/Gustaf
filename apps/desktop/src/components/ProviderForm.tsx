import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, Loader2, Radar, SquareTerminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { detectLocal, makeAdapter, PRESETS, saveProvider } from "../providers";
import { cliName, detectClis } from "../providers/cli";
import type { CliId, ModelInfo, ProviderConfig, ProviderKind } from "../providers/types";
import { useApp } from "../state";
import { ProviderIcon } from "./ProviderIcon";

const KINDS: ProviderKind[] = ["openai", "gemini", "anthropic", "openrouter", "cursor", "ollama", "lmstudio", "custom", "cli"];

/** Pick a provider kind, enter key/base URL, test the connection and save. Calls onSaved with the first model. */
export function ProviderForm({ existing, onSaved, onCancel }: { existing?: ProviderConfig; onSaved: (cfg: ProviderConfig, models: ModelInfo[]) => void; onCancel?: () => void }) {
  const t = useT();
  const [kind, setKind] = useState<ProviderKind>(existing?.kind ?? "openai");
  const [name, setName] = useState(existing?.name ?? PRESETS.openai.name);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? PRESETS.openai.baseUrl);
  const [key, setKey] = useState("");
  const [state, setState] = useState<{ busy?: boolean; ok?: number; error?: string }>({});
  const [found, setFound] = useState<ProviderKind[] | null>(null);
  const preset = kind === "cli" ? { name: "Cursor CLI", baseUrl: "", needsKey: true, keyUrl: PRESETS.cursor.keyUrl } : PRESETS[kind];
  const app = useApp();
  const [clis, setClis] = useState<{ id: CliId; version: string }[] | null>(null);
  useEffect(() => {
    if (!existing) detectClis().then(setClis, (e) => setState({ error: `CLI: ${e?.message ?? e}` }));
  }, [existing]);

  const choose = (k: ProviderKind) => {
    setKind(k);
    setName(k === "cli" ? "Cursor CLI — резервный" : PRESETS[k].name);
    setBaseUrl(PRESETS[k].baseUrl);
    setState({});
  };

  const cfg = (): ProviderConfig => ({ id: existing?.id ?? `${kind}-${Date.now().toString(36)}`, kind, ...(kind === "cli" ? { cli: "cursor-agent" as const, cliAuth: "key" as const } : {}), name: name.trim() || preset.name, baseUrl: baseUrl.trim() });

  const test = async () => {
    setState({ busy: true });
    try {
      const models = await makeAdapter(cfg(), key.trim()).listModels();
      setState({ ok: models.length });
      return models;
    } catch (e: any) {
      setState({ error: String(e?.message ?? e) });
      return null;
    }
  };

  const save = async () => {
    const models = state.ok != null ? await makeAdapter(cfg(), key.trim()).listModels().catch(() => []) : await test();
    if (!models) return;
    const c = cfg();
    await saveProvider(c, existing && !key ? null : key.trim());
    onSaved(c, models);
  };

  const canSave = (kind !== "custom" || baseUrl) && (!preset.needsKey || key || existing);

  const connectCli = async (id: CliId) => {
    setState({ busy: true });
    const c: ProviderConfig = { id: `cli-${id}-${Date.now().toString(36)}`, kind: "cli", name: cliName(id), baseUrl: "", cli: id };
    try {
      const models = await makeAdapter(c, "").listModels();
      await saveProvider(c, null);
      setState({});
      onSaved(c, models);
    } catch (e: any) {
      setState({ error: String(e?.message ?? e) });
    }
  };

  return (
    <div>
      {!existing && !!clis?.length && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-row">
            <SquareTerminal size={16} />
            <div className="grow d">{t("cliFound")}</div>
          </div>
          {clis.map((c) => {
            const added = app.providers.some((p) => p.cli === c.id);
            return (
              <div className="card-row" key={c.id}>
                <div className="grow">
                  {cliName(c.id)} <span className="d">{c.version}</span>
                </div>
                <button className="btn-soft" disabled={added || state.busy} onClick={() => connectCli(c.id)}>
                  {added ? <Check size={13} /> : null} {t(added ? "cliAdded" : "cliConnect")}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="kind-grid">
        {KINDS.map((k) => (
          <button key={k} className={`kind${kind === k ? " active" : ""}`} onClick={() => choose(k)} disabled={!!existing && existing.kind !== k}>
            <ProviderIcon kind={k} size={20} />
            {k === "cli" ? "Cursor CLI" : PRESETS[k].name}
          </button>
        ))}
      </div>
      {(kind === "ollama" || kind === "lmstudio") && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-row">
            <Radar size={16} />
            <div className="grow d">{found === null ? t("detectLocalHint") : found.length ? t("detectFound", { list: found.map((k) => PRESETS[k].name).join(", ") }) : t("detectNone")}</div>
            <button className="btn-soft" onClick={async () => setFound(await detectLocal())}>
              {t("detect")}
            </button>
          </div>
        </div>
      )}
      <label className="field">
        <span>{t("name")}</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {kind !== "cursor" && kind !== "cli" && (
        <label className="field">
          <span>Base URL</span>
          <input className="input" value={baseUrl} placeholder="https://example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span style={{ display: "flex", justifyContent: "space-between" }}>
          {t("apiKey")} {!preset.needsKey && `(${t("optional")})`}
          {preset.keyUrl && (
            <a href="#" onClick={(e) => (e.preventDefault(), openUrl(preset.keyUrl!))}>
              {t("getKey")} <ExternalLink size={11} />
            </a>
          )}
        </span>
        <input className="input" type="password" value={key} placeholder={existing ? t("keyUnchanged") : kind === "cursor" || kind === "cli" ? "cursor_…" : "sk-…"} onChange={(e) => setKey(e.target.value)} />
      </label>
      {kind === "cli" && <p className="hint" style={{ padding: 0 }}>{t("cursorCliAccountHint")}</p>}
      {kind === "cursor" && <p className="hint" style={{ padding: 0 }}>{t("cursorHint")}</p>}
      {state.error && <div className="error-box">{state.error}</div>}
      {state.ok != null && (
        <p className="ok" style={{ margin: "4px 0 10px" }}>
          <Check size={13} /> {t("connected", { count: state.ok })}
        </p>
      )}
      <div className="dialog-foot" style={{ marginTop: 10 }}>
        {onCancel && (
          <button className="btn btn-ghost" onClick={onCancel}>
            {t("cancel")}
          </button>
        )}
        <button className="btn-soft" onClick={test} disabled={state.busy || !canSave}>
          {state.busy ? <Loader2 size={13} className="spin" /> : null} {t("testConnection")}
        </button>
        <button className="btn btn-primary" onClick={save} disabled={state.busy || !canSave}>
          {t("save")}
        </button>
      </div>
    </div>
  );
}
