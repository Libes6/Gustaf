import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n";
import { providerKey, providerSecretId, secretPresence } from "../lib/keys";
import {
  antigravitySessionsInUse,
  authState,
  openAuthorizationUrl,
  probeAntigravity,
  signInAntigravity,
  signOutAntigravity,
  type AuthState,
} from "../providers/antigravity";
import {
  cancelRuntimeInstall,
  installRuntime,
  removeRuntime,
  runtimeStatus,
  type InstallProgress,
  type RuntimeStatus,
} from "../providers/antigravityRuntime";
import {
  AUTH_METHODS,
  configIssue,
  formatMb,
  normalizeSettings,
  usesBrowser,
  type AntigravityAuthMethod,
} from "../providers/antigravitySupport";
import type { ProviderConfig } from "../providers/types";
import { useApp } from "../state";
import { AntigravityRuntimeDialog, type RuntimeDialogMode } from "./AntigravityRuntimeDialog";
import { SettingRow } from "./SettingRow";

type Probe =
  | { state: "checking" }
  | { state: "ok"; version?: string }
  | { state: "missing" }
  | { state: "error"; message: string };
type Flow = { phase: "idle" | "waiting"; url?: string; error?: string; done?: boolean };

/** Where the managed runtime is in its life: idle, asking the user, working, or showing a failure. */
type Install =
  | { kind: "idle" }
  | { kind: "confirm"; mode: RuntimeDialogMode }
  | { kind: "running"; progress?: InstallProgress }
  | { kind: "removing" }
  | { kind: "error"; code: string; message: string };

const RUNTIME_ERROR: Record<string, string> = {
  unsupported: "antigravityUnsupported_platform",
  "intel-mac": "antigravityUnsupported_intelMac",
  platform: "antigravityUnsupported_platform",
  busy: "antigravityErr_busy",
  "no-space": "antigravityErr_noSpace",
  offline: "antigravityErr_offline",
  network: "antigravityErr_network",
  http: "antigravityErr_http",
  redirect: "antigravityErr_redirect",
  size: "antigravityErr_mismatch",
  hash: "antigravityErr_mismatch",
  "bad-archive": "antigravityErr_archive",
  verify: "antigravityErr_verify",
  "in-use": "antigravityErr_inUse",
  io: "antigravityErr_io",
} as const;
/** Codes whose English detail (sizes, status code, OS error) is worth showing after the translated sentence. */
const WITH_DETAIL = new Set(["no-space", "http", "io", "internal"]);

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
  const [rt, setRt] = useState<RuntimeStatus | undefined>();
  const [install, setInstall] = useState<Install>({ kind: "idle" });
  // Bumped after an install or removal so the probe and the status are read again.
  const [rev, setRev] = useState(0);
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
  }, [p.id, s.binary, rev]);
  useEffect(() => {
    let live = true;
    // The deep read re-hashes the installed files against the manifest (a second or two, off the UI thread).
    runtimeStatus(true).then(
      (r) => live && setRt(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [rev]);
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

  const idsOfAgy = app.providers.filter((x) => x.kind === "antigravity").map((x) => x.id);
  const startInstall = async () => {
    setInstall({ kind: "running" });
    try {
      await installRuntime((progress) => setInstall({ kind: "running", progress }));
      setInstall({ kind: "idle" });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setInstall(
        err.code === "cancelled"
          ? { kind: "idle" }
          : { kind: "error", code: err.code ?? "internal", message: String(err.message ?? e) },
      );
    }
    setRev((n) => n + 1);
  };
  const startRemove = async () => {
    setInstall({ kind: "removing" });
    try {
      await removeRuntime({
        inUse: antigravitySessionsInUse(idsOfAgy) || flow.phase === "waiting",
        protectedPaths: app.providers
          .filter((x) => x.kind === "antigravity")
          .map((x) => normalizeSettings(x.antigravity).binary ?? "")
          .filter(Boolean),
      });
      setInstall({ kind: "idle" });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setInstall({ kind: "error", code: err.code ?? "internal", message: String(err.message ?? e) });
    }
    setRev((n) => n + 1);
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
  const managed = rt?.installed ?? undefined;
  const running = install.kind === "running";
  const progressText =
    install.kind !== "running"
      ? ""
      : !install.progress
        ? t("antigravityPhase_starting")
        : install.progress.phase === "verify"
          ? t("antigravityPhase_verify")
          : t(install.progress.phase === "download" ? "antigravityPhase_download" : "antigravityPhase_extract", {
              received: formatMb(install.progress.received),
              total: formatMb(install.progress.total),
            });
  const errorText =
    install.kind === "error"
      ? t((RUNTIME_ERROR[install.code] ?? "antigravityErr_internal") as "antigravityErr_internal") +
        (WITH_DETAIL.has(install.code) || !RUNTIME_ERROR[install.code] ? ` ${install.message}` : "")
      : "";
  const runtimeText = managed
    ? managed.modified
      ? t("antigravityModified", { detail: managed.modified })
      : t("antigravityInstalledManaged", { version: managed.version })
    : probe.state === "checking"
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
      {install.kind === "confirm" && rt && (
        <AntigravityRuntimeDialog
          mode={install.mode}
          status={rt}
          onClose={() => setInstall({ kind: "idle" })}
          onConfirm={() => void (install.mode === "remove" ? startRemove() : startInstall())}
        />
      )}
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
              {rt?.supported && (
                <div>{t("antigravityDownload", { size: formatMb(rt.archiveBytes), version: rt.version })}</div>
              )}
              {rt && !rt.supported && (
                <div data-testid="agy-unsupported">
                  {t(rt.reason === "intel-mac" ? "antigravityUnsupported_intelMac" : "antigravityUnsupported_platform")}
                </div>
              )}
              <div
                className={
                  managed?.modified || (!managed && (probe.state === "missing" || probe.state === "error"))
                    ? "err"
                    : undefined
                }
                data-testid="agy-runtime-status"
              >
                {runtimeText}
              </div>
              {rt?.updateAvailable && !running && (
                <div data-testid="agy-update">{t("antigravityUpdateAvailable", { version: rt.version })}</div>
              )}
              {running && (
                <div role="status" data-testid="agy-progress">
                  {progressText}
                  {install.kind === "running" && install.progress && install.progress.phase !== "verify" && (
                    <progress
                      aria-label={progressText}
                      value={install.progress.received}
                      max={install.progress.total || 1}
                      style={{ display: "block", width: "100%" }}
                    />
                  )}
                </div>
              )}
              {install.kind === "error" && (
                <div className="err" role="alert">
                  {errorText}
                </div>
              )}
            </>
          }
        >
          {running ? (
            <>
              <button className="btn-soft" onClick={() => void cancelRuntimeInstall().catch(() => {})}>
                {t("cancel")}
              </button>
              <Loader2 size={14} className="spin" aria-hidden="true" />
            </>
          ) : (
            <>
              {(!managed || rt?.updateAvailable || managed.modified) && (
                <button
                  className="btn-soft"
                  disabled={!rt?.supported || rt.busy || install.kind === "removing" || p.disabled}
                  onClick={() =>
                    rt && setInstall({ kind: "confirm", mode: managed && !managed.modified ? "update" : "install" })
                  }
                >
                  {managed && !managed.modified
                    ? t("antigravityUpdate", { version: rt?.version ?? "" })
                    : t("antigravityInstall")}
                </button>
              )}
              {managed && (
                <button
                  className="btn-soft"
                  disabled={install.kind === "removing"}
                  onClick={() => setInstall({ kind: "confirm", mode: "remove" })}
                >
                  {t("antigravityRemove")}
                </button>
              )}
            </>
          )}
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
