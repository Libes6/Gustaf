import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { providerKey, providerSecretId, secretPresence } from "../lib/keys";
import {
  authState,
  openAuthorizationUrl,
  probeAntigravity,
  signInAntigravity,
  signOutAntigravity,
  type AuthState,
} from "../providers/antigravity";
import { RUNTIME_INSTALL_AVAILABLE, RUNTIME_SIZE_MB, RUNTIME_VERSION } from "../providers/antigravityRuntime";
import {
  AUTH_METHODS,
  configIssue,
  normalizeSettings,
  usesBrowser,
  type AntigravityAuthMethod,
} from "../providers/antigravitySupport";
import type { ProviderConfig } from "../providers/types";
import { useApp } from "../state";
import { SettingRow } from "./SettingRow";

type Probe =
  | { state: "checking" }
  | { state: "ok"; version?: string }
  | { state: "missing" }
  | { state: "error"; message: string };
type Flow = { phase: "idle" | "waiting"; url?: string; error?: string; done?: boolean };

const ISSUE = {
  project: "antigravityIssue_project",
  apiKey: "antigravityIssue_apiKey",
  apiKeyOrProject: "antigravityIssue_apiKeyOrProject",
} as const;

const METHOD_LABEL = {
  "oauth-personal": "antigravityMethodPersonal",
  "oauth-business": "antigravityMethodBusiness",
  "gemini-api-key": "antigravityMethodKey",
  "agent-platform": "antigravityMethodPlatform",
} as const;

/** Settings of an Antigravity provider: setup (runtime, Google account) and the runtime options. */
export function AntigravitySettings({
  p,
  update,
}: {
  p: ProviderConfig;
  update: (p: ProviderConfig, key?: string | null) => Promise<unknown>;
}) {
  const t = useT();
  const app = useApp();
  const s = normalizeSettings(p.antigravity);
  const [binary, setBinary] = useState(s.binary ?? "");
  const [project, setProject] = useState(s.project ?? "");
  const [location, setLocation] = useState(s.location ?? "");
  const [key, setKey] = useState("");
  const [probe, setProbe] = useState<Probe>({ state: "checking" });
  const [auth, setAuth] = useState<AuthState | undefined>();
  const [flow, setFlow] = useState<Flow>({ phase: "idle" });
  const ctl = useRef<AbortController | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const issue = configIssue(s, hasKey);

  useEffect(() => {
    let live = true;
    probeAntigravity(p, providerKey(p.id, p.name)).then(
      (r) => live && setProbe({ state: "ok", version: r.version }),
      (e: { code?: string; message?: string }) =>
        live &&
        setProbe(
          e?.code === "not-installed" ? { state: "missing" } : { state: "error", message: String(e?.message ?? e) },
        ),
    );
    return () => {
      live = false;
    };
    // The probe depends on how the agent is launched, not on the display name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, s.binary]);
  useEffect(() => {
    void secretPresence(providerSecretId(p.id)).then((v) => setHasKey(v === true));
    void authState(p.id).then(setAuth);
  }, [p.id]);
  useEffect(() => () => ctl.current?.abort(), []);

  const save = (patch: Partial<typeof s>) => update({ ...p, antigravity: normalizeSettings({ ...s, ...patch }) });

  const signIn = async () => {
    const c = new AbortController();
    ctl.current = c;
    setFlow({ phase: "waiting" });
    try {
      await signInAntigravity(p, providerKey(p.id, p.name), {
        signal: c.signal,
        onUrl: (url) => {
          setFlow({ phase: "waiting", url });
          openAuthorizationUrl(url).catch(() => {});
        },
      });
      setFlow({ phase: "idle", done: true });
      setAuth(await authState(p.id));
      await app.refreshModels({ only: [p.id] });
    } catch (e) {
      setFlow({ phase: "idle", error: c.signal.aborted ? undefined : String((e as Error)?.message ?? e) });
    } finally {
      ctl.current = null;
    }
  };
  const signOut = async () => {
    await signOutAntigravity(p, providerKey(p.id, p.name));
    setAuth(await authState(p.id));
    setFlow({ phase: "idle" });
    await app.refreshModels({ refresh: "startup" });
  };

  const waiting = flow.phase === "waiting";
  const browser = usesBrowser(s.method);
  const needsGcp = s.method === "oauth-business" || s.method === "agent-platform";
  const authText = waiting
    ? t("antigravityWaiting")
    : auth?.state === "signedIn"
      ? t("antigravitySignedIn", {
          method: t(METHOD_LABEL[normalizeSettings({ method: auth.method as AntigravityAuthMethod }).method]),
        })
      : auth?.state === "signedOut"
        ? t("antigravitySignedOut")
        : t("antigravitySignInUnknown");
  const runtimeText =
    probe.state === "checking"
      ? t("antigravityChecking")
      : probe.state === "ok"
        ? probe.version
          ? t("antigravityInstalled", { version: probe.version })
          : t("antigravityInstalledNoVersion")
        : probe.state === "missing"
          ? t("antigravityNotInstalled")
          : t("antigravityProbeError", { message: probe.message });

  return (
    <>
      <h4 aria-level={2}>{t("antigravitySetup")}</h4>
      <div className="card">
        <SettingRow title={t("antigravityEnvTitle")} description={t("antigravityEnvDesc")}>
          <span className="d">{t("antigravityEnvValue")}</span>
        </SettingRow>
        <SettingRow
          testId="agy-runtime"
          title={t("antigravityRuntimeTitle")}
          description={
            <>
              <div>{t("antigravityRuntimeDesc")}</div>
              <div>{t("antigravityDownload", { size: RUNTIME_SIZE_MB, version: RUNTIME_VERSION })}</div>
              <div
                className={probe.state === "missing" || probe.state === "error" ? "err" : undefined}
                data-testid="agy-runtime-status"
              >
                {runtimeText}
              </div>
              {!RUNTIME_INSTALL_AVAILABLE && <div>{t("antigravityInstallSoon")}</div>}
            </>
          }
        >
          <button className="btn-soft" disabled={!RUNTIME_INSTALL_AVAILABLE}>
            {t("antigravityInstall")}
          </button>
        </SettingRow>
        <SettingRow
          testId="agy-account"
          title={t("antigravityAccountTitle")}
          description={
            <>
              <div>{t("antigravityAccountDesc")}</div>
              <div data-testid="agy-auth-status">{authText}</div>
              {issue && <div className="err">{t(ISSUE[issue])}</div>}
              {flow.error && (
                <div className="err" role="alert">
                  {flow.error}
                </div>
              )}
              {flow.done && <div role="status">{t("antigravitySignInDone")}</div>}
            </>
          }
        >
          {waiting ? (
            <>
              {flow.url && (
                <button className="btn-ghost small" onClick={() => openAuthorizationUrl(flow.url!).catch(() => {})}>
                  {t("antigravityReopen")}
                </button>
              )}
              <button className="btn-soft" onClick={() => ctl.current?.abort()}>
                {t("cancel")}
              </button>
              <Loader2 size={14} className="spin" aria-hidden="true" />
            </>
          ) : (
            <>
              <button className="btn-soft" disabled={!!issue || p.disabled} onClick={signIn}>
                {t(browser ? "antigravitySignIn" : "antigravityConnect")}
              </button>
              <button className="btn-soft" onClick={signOut}>
                {t("antigravitySignOut")}
              </button>
            </>
          )}
        </SettingRow>
      </div>
      <h4 aria-level={2}>{t("runtime")}</h4>
      <div className="card">
        <SettingRow id="antigravityBinary" title={t("antigravityBinary")} description={t("antigravityBinaryDesc")}>
          <input
            aria-label={t("antigravityBinary")}
            className="input narrow"
            value={binary}
            placeholder="agy_acp_server"
            onChange={(e) => setBinary(e.target.value)}
            onBlur={() => binary.trim() !== (s.binary ?? "") && save({ binary: binary.trim() })}
          />
        </SettingRow>
        <SettingRow id="antigravityMethod" title={t("antigravityMethod")} description={t("antigravityMethodDesc")}>
          <select
            aria-label={t("antigravityMethod")}
            className="input narrow"
            value={s.method}
            onChange={(e) => save({ method: e.target.value as AntigravityAuthMethod })}
          >
            {AUTH_METHODS.map((m) => (
              <option key={m} value={m}>
                {t(METHOD_LABEL[m])}
              </option>
            ))}
          </select>
        </SettingRow>
        {(s.method === "gemini-api-key" || s.method === "agent-platform") && (
          <SettingRow id="antigravityApiKey" title={t("apiKey")} description={t("antigravityKeyDesc")}>
            <input
              aria-label={t("apiKey")}
              className="input narrow"
              type="password"
              autoComplete="off"
              placeholder="••••••••"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              className="btn-soft"
              disabled={!key.trim()}
              onClick={() => update(p, key.trim()).then(() => (setHasKey(true), setKey("")))}
            >
              {t("save")}
            </button>
          </SettingRow>
        )}
        {needsGcp && (
          <>
            <SettingRow id="antigravityProject" title={t("antigravityProject")}>
              <input
                aria-label={t("antigravityProject")}
                className="input narrow"
                value={project}
                onChange={(e) => setProject(e.target.value)}
                onBlur={() => project.trim() !== (s.project ?? "") && save({ project: project.trim() })}
              />
            </SettingRow>
            <SettingRow id="antigravityLocation" title={t("antigravityLocation")}>
              <input
                aria-label={t("antigravityLocation")}
                className="input narrow"
                value={location}
                placeholder="us-central1"
                onChange={(e) => setLocation(e.target.value)}
                onBlur={() => location.trim() !== (s.location ?? "") && save({ location: location.trim() })}
              />
            </SettingRow>
          </>
        )}
      </div>
    </>
  );
}
