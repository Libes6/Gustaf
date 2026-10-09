// Antigravity (Google's ACP agent, `agy_acp_server`): the pure parts of launching it and signing in. No Tauri, no I/O,
// unit-tested in tests/antigravitySupport.test.mjs. The facts below come from the public registry entry
// (github.com/agentclientprotocol/registry, antigravity-acp) and from how T3 Code drives the same binary (MIT,
// github.com/pingdotgg/t3code, apps/server/src/provider/antigravityAuthSupport.ts and acp/AntigravityAcpSupport.ts);
// none of it was checked against the real binary (it is proprietary and was not downloaded for this work).
import type { ConfigOption, SessionSetup } from "./acp/client.ts";
import { quote, psq, type ShellKind } from "./shell.ts";
import type { ModelInfo, Reasoning } from "./types.ts";

/** ACP `authenticate` method ids of the agent. */
export type AntigravityAuthMethod = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";
export const AUTH_METHODS: readonly AntigravityAuthMethod[] = [
  "oauth-personal",
  "oauth-business",
  "gemini-api-key",
  "agent-platform",
];

/** Non-secret settings of an Antigravity provider (the API key lives in the Keychain, never here). */
export type AntigravitySettings = {
  /** Path of `agy_acp_server`; empty: looked up on PATH. */
  binary?: string;
  method: AntigravityAuthMethod;
  /** GCP project and location (Gemini Enterprise, Vertex AI). */
  project?: string;
  location?: string;
};

export const DEFAULT_SETTINGS: AntigravitySettings = { method: "oauth-personal" };

export const normalizeSettings = (s: Partial<AntigravitySettings> | undefined): AntigravitySettings => ({
  method: AUTH_METHODS.includes(s?.method as AntigravityAuthMethod)
    ? (s!.method as AntigravityAuthMethod)
    : "oauth-personal",
  ...(s?.binary?.trim() ? { binary: s.binary.trim() } : {}),
  ...(s?.project?.trim() ? { project: s.project.trim() } : {}),
  ...(s?.location?.trim() ? { location: s.location.trim() } : {}),
});

/** The two methods that open a Google sign-in page. */
export const usesBrowser = (m: AntigravityAuthMethod) => m === "oauth-personal" || m === "oauth-business";

export type ConfigIssue = "project" | "apiKey" | "apiKeyOrProject";

/** What is missing before the method can authenticate, or null. `hasKey`: an API key is stored. */
export function configIssue(s: AntigravitySettings, hasKey: boolean): ConfigIssue | null {
  switch (s.method) {
    case "oauth-personal":
      return null;
    case "oauth-business":
      return s.project && s.location ? null : "project";
    case "gemini-api-key":
      return hasKey ? null : "apiKey";
    case "agent-platform":
      return hasKey || (s.project && s.location) ? null : "apiKeyOrProject";
  }
}

/**
 * `settings.json` for the agent's private profile: names the method (so a sign-out clears only its credentials) and
 * carries the GCP project and location. Never holds a credential.
 */
export function profileSettingsJson(s: AntigravitySettings): string {
  const gcp = { ...(s.project ? { project: s.project } : {}), ...(s.location ? { location: s.location } : {}) };
  return JSON.stringify({ auth: { type: s.method }, ...(Object.keys(gcp).length ? { gcp } : {}) });
}

/** Variables of the user's own environment that would override the selected method. They are unset before launch. */
export const SCRUBBED_ENV = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "ANTIGRAVITY_HARNESS_PATH",
];

/** Marker the BROWSER helper prints (to stderr) so the app, not the agent, opens the sign-in page. */
export const BROWSER_MARKER = "GUSTAF_AGY_AUTH_URL=";
/** The line the agent itself prints when it wants the user to open a link. */
export const AUTH_PREFIX = "Open the following link to authenticate the ACP server: ";

/**
 * The environment added to the agent's own: its private home (sign-in lives there), a temp folder the app can clean,
 * the credential of the selected method and, on POSIX systems, a `BROWSER` command that reports the link instead of
 * opening it. The command must not contain `:` or `;` (Python splits `BROWSER` on the path separator first).
 */
export function launchEnv(o: {
  geminiHome: string;
  tempDir: string;
  method: AntigravityAuthMethod;
  apiKey?: string;
  platform: "macos" | "linux" | "windows";
}): Record<string, string> {
  const credential: Record<string, string> =
    o.method === "gemini-api-key" && o.apiKey
      ? { GEMINI_API_KEY: o.apiKey }
      : o.method === "agent-platform" && o.apiKey
        ? { GOOGLE_API_KEY: o.apiKey }
        : {};
  return {
    ...credential,
    GEMINI_HOME: o.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    PYTHONUNBUFFERED: "1",
    ...(o.platform === "windows" ? { TEMP: o.tempDir, TMP: o.tempDir } : { TMPDIR: o.tempDir }),
    ...(o.platform === "windows" ? {} : { BROWSER: `sh -c 'printf "${BROWSER_MARKER}%s\\n" "$1" >&2' sh %s` }),
  };
}

/** Rejects binary paths that cannot be one (control characters, absurd length). Blank is fine (PATH lookup). */
export function validBinary(path: string | undefined): boolean {
  if (!path) return true;
  // eslint-disable-next-line no-control-regex
  return path.length <= 1000 && !/[\u0000-\u001f]/.test(path);
}

/**
 * The login-shell script that starts the agent. The scrub removes ambient credentials, then the binary is `exec`ed
 * (so the stored pid is the agent's own). Blank `binary`: `agy_acp_server`, or the `.par` name the registry ships on
 * macOS and Linux, from PATH. The shell exits 127 when it is not installed.
 */
export function launchScript(kind: ShellKind, binary: string | undefined): string {
  if (kind === "powershell") {
    const scrub = SCRUBBED_ENV.map((v) => `Remove-Item Env:${v} -ErrorAction SilentlyContinue`).join("; ");
    return `${scrub}; & ${psq(binary || "agy_acp_server.exe")}; exit $LASTEXITCODE`;
  }
  const scrub = `unset ${SCRUBBED_ENV.join(" ")}; `;
  if (binary) return `${scrub}exec ${quote(kind, binary)}`;
  return (
    `${scrub}bin=$(command -v agy_acp_server || command -v agy_acp_server.par) || ` +
    `{ echo "agy_acp_server not found" >&2; exit 127; }; exec "$bin"`
  );
}

// ---- the sign-in link -------------------------------------------------------------------------------------------------

const MAX_URL = 16_384;

/**
 * A Google authorization URL the agent reported, if it is exactly what a local-redirect OAuth flow looks like:
 * `https://accounts.google.com/o/oauth2/v2/auth`, no credentials or fragment, `response_type=code`, a `state`, and a
 * `redirect_uri` of `http://127.0.0.1:<port>/` (the agent's own listener). Anything else is refused, so a hostile
 * output line can never make the app open an arbitrary page.
 */
export function parseAuthorizationUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text || text.length > MAX_URL || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const state = url.searchParams.get("state");
  const redirect = url.searchParams.get("redirect_uri");
  const ok =
    url.protocol === "https:" &&
    url.origin === "https://accounts.google.com" &&
    url.pathname === "/o/oauth2/v2/auth" &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.searchParams.getAll("state").length === 1 &&
    url.searchParams.getAll("redirect_uri").length === 1 &&
    url.searchParams.get("response_type") === "code" &&
    !!state &&
    state.length <= 512 &&
    !!redirect &&
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirect) &&
    Number(new URL(redirect).port) >= 1024;
  return ok ? url.toString() : null;
}

/** The authorization URL on one output line (the agent's own message or the BROWSER helper's marker), validated. */
export function authUrlFromLine(line: string): string | null {
  const l = line.replace(/\r$/, "");
  if (l.length > MAX_URL + 100) return null;
  if (l.startsWith(AUTH_PREFIX)) return parseAuthorizationUrl(l.slice(AUTH_PREFIX.length));
  if (l.startsWith(BROWSER_MARKER)) return parseAuthorizationUrl(l.slice(BROWSER_MARKER.length));
  return null;
}

/** Splits chunks of a text stream into lines; a partial line waits for its end and an endless line is dropped. */
export function lineSplitter(onLine: (line: string) => void, maxLine = MAX_URL + 200) {
  let pending = "";
  return (chunk: string) => {
    const parts = (pending + chunk).split("\n");
    pending = parts.pop() ?? "";
    if (pending.length > maxLine) pending = "";
    for (const p of parts) onLine(p);
  };
}

// ---- models and reasoning from the session ---------------------------------------------------------------------------

export const modelOption = (configs: ConfigOption[]) =>
  configs.find((o) => o.id === "model") ?? configs.find((o) => o.category === "model");

export const thoughtOption = (configs: ConfigOption[]) =>
  configs.find((o) => o.category === "thought_level") ?? configs.find((o) => o.id === "thought_level");

/** The models of a session: its `model` config option, else the legacy `models` block. First entry: the agent's default. */
export function modelsFromSession(
  setup: Pick<SessionSetup, "configOptions" | "models">,
  providerId: string,
): ModelInfo[] {
  const opt = modelOption(setup.configOptions);
  const entries = opt?.options.length
    ? opt.options.map((c) => ({ id: c.value, name: c.name }))
    : (setup.models?.available ?? []);
  const seen = new Set<string>(["default"]);
  const list: ModelInfo[] = [{ id: "default", name: "Default", providerId, created: 0, tools: true, images: true }];
  for (const e of entries) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    list.push({ id: e.id, name: e.name || e.id, providerId, created: 0, tools: true, images: true });
  }
  return list;
}

const LEVELS: Record<string, Reasoning> = {
  low: "low",
  minimal: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** Reasoning levels the session's thought-level option offers: level -> the option's own value. */
export function thoughtLevels(configs: ConfigOption[]): Partial<Record<Reasoning, string>> {
  const out: Partial<Record<Reasoning, string>> = {};
  for (const c of thoughtOption(configs)?.options ?? []) {
    const level = LEVELS[c.value.toLowerCase()] ?? LEVELS[c.name.toLowerCase()];
    if (level && !out[level]) out[level] = c.value;
  }
  return out;
}

/** Plain-text summary of an agent error for the status line: no stack, bounded, never an object dump. */
export function safeMessage(e: unknown, secrets: readonly string[] = []): string {
  let m = e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";
  for (const s of secrets) if (s.length >= 4) m = m.split(s).join("***");
  return m.replace(/\s+/g, " ").trim().slice(0, 400);
}
