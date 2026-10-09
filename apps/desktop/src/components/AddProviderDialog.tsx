import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, ExternalLink, Loader2, Radar, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { useDialogFocus } from "../lib/useDialogFocus";
import { detectLocal, makeAdapter, PRESETS, saveProvider } from "../providers";
import { cliName, detectClis } from "../providers/cli";
import type { CliId, ModelInfo, ProviderConfig, ProviderKind } from "../providers/types";
import { CursorAccounts } from "./CursorAccounts";
import { ProviderIcon } from "./ProviderIcon";

/** Driver tiles of the "Add provider" wizard; `soon` tiles are visual placeholders only. */
export type TileId =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "openrouter"
  | "local"
  | "gemini"
  | "custom"
  | "copilot"
  | "opencode"
  | "antigravity";
type Method = { id: string; kind: ProviderKind; cli?: CliId; cliAuth?: "key"; browser?: boolean };
type Clis = { id: CliId; version: string }[];

const TILES: { id: TileId; kind: ProviderKind; cli?: CliId; soon?: boolean }[] = [
  { id: "claude", kind: "anthropic" },
  { id: "codex", kind: "openai" },
  { id: "cursor", kind: "cursor" },
  { id: "grok", kind: "xai" },
  { id: "openrouter", kind: "openrouter" },
  { id: "local", kind: "ollama" },
  { id: "gemini", kind: "gemini" },
  { id: "antigravity", kind: "antigravity" },
  { id: "custom", kind: "custom" },
  { id: "copilot", kind: "custom", soon: true },
  { id: "opencode", kind: "custom", soon: true },
];

const METHODS: Record<TileId, Method[]> = {
  claude: [
    { id: "cli", kind: "cli", cli: "claude" },
    { id: "api", kind: "anthropic" },
  ],
  codex: [
    { id: "cli", kind: "cli", cli: "codex" },
    { id: "api", kind: "openai" },
  ],
  cursor: [
    { id: "browser", kind: "cli", cli: "cursor-agent", browser: true },
    { id: "cli", kind: "cli", cli: "cursor-agent" },
    { id: "clikey", kind: "cli", cli: "cursor-agent", cliAuth: "key" },
    { id: "sdk", kind: "cursor" },
  ],
  grok: [{ id: "api", kind: "xai" }],
  openrouter: [{ id: "api", kind: "openrouter" }],
  local: [
    { id: "ollama", kind: "ollama" },
    { id: "lmstudio", kind: "lmstudio" },
  ],
  gemini: [{ id: "api", kind: "gemini" }],
  antigravity: [{ id: "agent", kind: "antigravity" }],
  custom: [{ id: "api", kind: "custom" }],
  copilot: [],
  opencode: [],
};

const needsKey = (m: Method) => (m.kind === "cli" ? m.cliAuth === "key" : PRESETS[m.kind].needsKey);
const keyUrl = (m: Method) =>
  m.kind === "cli" ? (m.cliAuth === "key" ? PRESETS.cursor.keyUrl : undefined) : PRESETS[m.kind].keyUrl;
const defaultName = (m: Method) =>
  m.kind === "cli" ? (m.cliAuth === "key" ? "Cursor CLI" : cliName(m.cli!)) : PRESETS[m.kind].name;
/** The first usable sign-in method of a driver: a CLI only when it is installed (browser sign-in always works). */
const bestMethod = (id: TileId, clis: Clis) =>
  METHODS[id].find((m) => m.browser || m.kind !== "cli" || m.cliAuth || clis.some((c) => c.id === m.cli)) ??
  METHODS[id][0];
const signInCommand = (cli: CliId) =>
  cli === "claude" ? "claude auth login" : cli === "cursor-agent" ? "cursor-agent login" : "codex login";

/**
 * The three-step "Add provider" flow (Driver, Identity, Config), shared by the providers page dialog and onboarding.
 * Saving stores the key through `saveProvider` (Keychain) and reports the listed models.
 */
export function AddProviderWizard({
  initialTile,
  clis: knownClis,
  onSaved,
  onCancel,
}: {
  initialTile?: TileId;
  clis?: Clis;
  onSaved: (cfg: ProviderConfig, models: ModelInfo[]) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const [step, setStep] = useState<0 | 1 | 2>(initialTile ? 1 : 0);
  const [tile, setTile] = useState<TileId>(initialTile ?? "claude");
  const [method, setMethod] = useState<Method>(() => bestMethod(initialTile ?? "claude", knownClis ?? []));
  const [name, setName] = useState(() => defaultName(method));
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(method.kind === "cli" ? "" : PRESETS[method.kind].baseUrl);
  const [state, setState] = useState<{ busy?: boolean; ok?: number; error?: string }>({});
  const [found, setFound] = useState<ProviderKind[] | null>(null);
  const [detected, setDetected] = useState<Clis | null>(knownClis ?? null);
  useEffect(() => {
    if (!knownClis) detectClis().then(setDetected, () => setDetected([]));
  }, [knownClis]);
  const clis = knownClis ?? detected ?? [];

  const pickMethod = (m: Method) => {
    setMethod(m);
    setName(defaultName(m));
    setBaseUrl(m.kind === "cli" ? "" : PRESETS[m.kind].baseUrl);
    setState({});
  };
  const pickTile = (id: TileId) => {
    setTile(id);
    pickMethod(bestMethod(id, clis));
    setKey("");
    setStep(1);
  };

  const cfg = (): ProviderConfig => ({
    id: `${method.kind === "cli" ? `cli-${method.cli}` : method.kind}-${Date.now().toString(36)}`,
    kind: method.kind,
    ...(method.cli ? { cli: method.cli } : {}),
    ...(method.cliAuth ? { cliAuth: method.cliAuth } : {}),
    name: name.trim() || defaultName(method),
    baseUrl: baseUrl.trim(),
  });

  const test = async (c = cfg()) => {
    setState({ busy: true });
    try {
      const models = await makeAdapter(c, key.trim()).listModels();
      setState({ ok: models.length });
      return models;
    } catch (e: any) {
      setState({ error: String(e?.message ?? e) });
      return null;
    }
  };

  const save = async () => {
    const c = cfg();
    if (method.kind === "antigravity") {
      await saveProvider({ ...c, antigravity: { method: "oauth-personal" } }, null);
      onSaved(c, []);
      return;
    }
    const models = await test(c);
    if (!models) return;
    // CLIs keep their own sign-in: nothing goes to the Keychain unless the method uses a key.
    await saveProvider(c, method.kind === "cli" && !method.cliAuth ? null : key.trim());
    onSaved(c, models);
  };

  const cliInfo = method.cli && !method.browser && !method.cliAuth ? clis.find((c) => c.id === method.cli) : undefined;
  const cliMissing = !!method.cli && !method.browser && !method.cliAuth && !cliInfo;
  const keyOk = !needsKey(method) || !!key.trim();
  const hasBaseUrl = method.kind !== "cli" && method.kind !== "cursor" && method.kind !== "antigravity";
  // These need no key and cannot be tested before sign-in: "Connect" saves the provider, the settings page signs in.
  const direct = (method.kind === "cli" && !method.cliAuth) || method.kind === "antigravity";
  const canSave = keyOk && (method.kind !== "custom" || !!baseUrl.trim()) && !cliMissing;
  const methodLabel = (m: Method) =>
    m.browser
      ? t("provMethodBrowser")
      : m.cliAuth
        ? t("provMethodCliKey")
        : m.kind === "cli"
          ? `${cliName(m.cli!)} CLI`
          : m.kind === "cursor"
            ? t("provMethodSdk")
            : t("provMethodApi", { name: PRESETS[m.kind].name });
  const tileLabel = (id: TileId) =>
    id === "codex"
      ? "Codex / OpenAI"
      : id === "local"
        ? t("provLocal")
        : id === "custom"
          ? t("provCustom")
          : id === "copilot"
            ? "GitHub Copilot"
            : id === "opencode"
              ? "OpenCode"
              : id === "claude"
                ? "Claude"
                : id === "grok"
                  ? "Grok"
                  : PRESETS[TILES.find((x) => x.id === id)!.kind].name;

  const steps = [t("provStepDriver"), t("provStepIdentity"), t("provStepConfig")];
  return (
    <div className="wizard">
      <ol className="wizard-steps" aria-label={t("stepOf", { n: step + 1, total: 3 })}>
        {steps.map((s, i) => (
          <li
            key={s}
            className={i === step ? "on" : i < step ? "done" : ""}
            aria-current={i === step ? "step" : undefined}
          >
            <span className="n">{i < step ? <Check size={11} /> : i + 1}</span> {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="kind-grid" role="group" aria-label={t("provStepDriver")}>
          {TILES.map((x) => (
            <button
              key={x.id}
              className={`kind${tile === x.id ? " active" : ""}${x.soon ? " soon" : ""}`}
              disabled={x.soon}
              onClick={() => pickTile(x.id)}
            >
              <ProviderIcon kind={x.kind} cli={x.cli} size={20} />
              {tileLabel(x.id)}
              {x.soon && <span className="soon-tag">{t("provComingSoon")}</span>}
            </button>
          ))}
        </div>
      )}

      {step === 1 && (
        <>
          {METHODS[tile].length > 1 && (
            <div className="card method-list" role="radiogroup" aria-label={t("provStepIdentity")}>
              {METHODS[tile].map((m) => {
                const info =
                  m.kind === "cli" && !m.browser && !m.cliAuth ? clis.find((c) => c.id === m.cli) : undefined;
                return (
                  <label className="card-row" key={m.id}>
                    <input type="radio" name="method" checked={method.id === m.id} onChange={() => pickMethod(m)} />
                    <div className="grow">
                      <div className="t">{methodLabel(m)}</div>
                      {m.kind === "cli" && !m.browser && !m.cliAuth && (
                        <div className="d">
                          {info ? t("provCliFound", { version: info.version }) : t("provCliMissing")}
                        </div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          )}
          {method.browser ? (
            <>
              <CursorAccounts />
              <p className="hint" style={{ padding: 0 }}>
                {t("provBrowserDone")}
              </p>
            </>
          ) : (
            <>
              <label className="field">
                <span>{t("name")}</span>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              {method.kind === "antigravity" ? (
                <p className="hint" style={{ padding: 0 }}>
                  {t("antigravityAbout")}
                </p>
              ) : method.kind === "cli" && !method.cliAuth ? (
                <p className="hint" style={{ padding: 0 }}>
                  <SquareTerminal size={13} />{" "}
                  {cliMissing ? t("provCliMissing") : t("provCliSignIn", { command: signInCommand(method.cli!) })}
                </p>
              ) : (
                <KeyField
                  t={t}
                  url={keyUrl(method)}
                  optional={!needsKey(method)}
                  value={key}
                  onChange={setKey}
                  placeholder={
                    method.kind === "cursor" || method.cliAuth ? "cursor_…" : method.kind === "xai" ? "xai-…" : "sk-…"
                  }
                />
              )}
              {method.cliAuth && (
                <p className="hint" style={{ padding: 0 }}>
                  {t("cursorCliAccountHint")}
                </p>
              )}
              {method.kind === "cursor" && (
                <p className="hint" style={{ padding: 0 }}>
                  {t("cursorHint")}
                </p>
              )}
            </>
          )}
        </>
      )}

      {step === 2 && (
        <>
          {(method.kind === "ollama" || method.kind === "lmstudio") && (
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="card-row">
                <Radar size={16} />
                <div className="grow d">
                  {found === null
                    ? t("detectLocalHint")
                    : found.length
                      ? t("detectFound", { list: found.map((k) => PRESETS[k].name).join(", ") })
                      : t("detectNone")}
                </div>
                <button className="btn-soft" onClick={async () => setFound(await detectLocal())}>
                  {t("detect")}
                </button>
              </div>
            </div>
          )}
          {hasBaseUrl ? (
            <label className="field">
              <span>Base URL</span>
              <input
                className="input"
                value={baseUrl}
                placeholder="https://example.com/v1"
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </label>
          ) : method.kind === "cli" ? (
            <div className="card">
              <div className="card-row">
                <div className="grow">
                  <div className="t">{t("command")}</div>
                  <div className="d">{t("cliCommandHint")}</div>
                </div>
                <code className="mono">{method.cli}</code>
              </div>
            </div>
          ) : (
            <p className="hint" style={{ padding: 0 }}>
              {t("provNoBaseUrl")}
            </p>
          )}
        </>
      )}

      {state.error && <div className="error-box">{state.error}</div>}
      {state.ok != null && (
        <p className="ok" style={{ margin: "4px 0 10px" }}>
          <Check size={13} /> {t("connected", { count: state.ok })}
        </p>
      )}

      <div className="dialog-foot">
        {onCancel && (
          <button className="btn btn-ghost" onClick={onCancel}>
            {t("cancel")}
          </button>
        )}
        <span className="grow" />
        {step > 0 && (
          <button className="btn-soft" onClick={() => (setState({}), setStep(step === 2 ? 1 : 0))}>
            {t("provBack")}
          </button>
        )}
        {step === 1 && !method.browser && direct && (
          <>
            {method.kind === "cli" && (
              <button className="btn-soft" onClick={() => setStep(2)}>
                {t("provConfigureManually")}
              </button>
            )}
            <button className="btn btn-primary" disabled={state.busy || cliMissing} onClick={save}>
              {state.busy ? <Loader2 size={13} className="spin" /> : null} {t("cliConnect")}
            </button>
          </>
        )}
        {step === 1 && method.browser && onCancel && (
          <button className="btn btn-primary" onClick={onCancel}>
            {t("provDone")}
          </button>
        )}
        {step === 1 && !method.browser && !direct && (
          <button className="btn btn-primary" disabled={!keyOk} onClick={() => (setState({}), setStep(2))}>
            {t("provNext")}
          </button>
        )}
        {step === 2 && (
          <>
            <button className="btn-soft" onClick={() => test()} disabled={state.busy || !canSave}>
              {state.busy ? <Loader2 size={13} className="spin" /> : null} {t("testConnection")}
            </button>
            <button className="btn btn-primary" onClick={save} disabled={state.busy || !canSave}>
              {t("save")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function KeyField({
  t,
  url,
  optional,
  value,
  onChange,
  placeholder,
}: {
  t: ReturnType<typeof useT>;
  url?: string;
  optional: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="field">
      <span style={{ display: "flex", justifyContent: "space-between" }}>
        {t("apiKey")} {optional && `(${t("optional")})`}
        {url && (
          <a href="#" onClick={(e) => (e.preventDefault(), openUrl(url))}>
            {t("getKey")} <ExternalLink size={11} />
          </a>
        )}
      </span>
      <input
        className="input"
        type="password"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Modal wrapper of the wizard used by the providers page ("+" and the "Connect" actions of unconfigured drivers). */
export function AddProviderDialog({
  initialTile,
  clis,
  onSaved,
  onClose,
}: {
  initialTile?: TileId;
  clis?: Clis;
  onSaved: (cfg: ProviderConfig, models: ModelInfo[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, onClose);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="dialog wide" role="dialog" aria-modal="true" aria-label={t("provAddTitle")}>
        <h2>
          <span className="grow">{t("provAddTitle")}</span>
        </h2>
        <AddProviderWizard initialTile={initialTile} clis={clis} onSaved={onSaved} onCancel={onClose} />
      </div>
    </div>
  );
}
