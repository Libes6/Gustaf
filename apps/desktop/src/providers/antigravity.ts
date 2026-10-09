import { openUrl } from "@tauri-apps/plugin-opener";
import { antigravityProfiles, getSetting, setSetting } from "../lib/api";
import { providerSecretId, resolveKey, secretPresence, type KeySource } from "../lib/keys";
import { currentPlatform } from "../lib/platform";
import {
  listAgentModels,
  probeAgent,
  runAntigravityTurn,
  signInAgent,
  signOutAgent,
  AntigravityError,
  type AgentDeps,
  type Probe,
  type SessionInfo,
} from "./antigravitySession";
import {
  authUrlFromLine,
  launchEnv,
  launchScript,
  lineSplitter,
  normalizeSettings,
  parseAuthorizationUrl,
  profileSettingsJson,
  validBinary,
  type AntigravitySettings,
} from "./antigravitySupport";
import { openJsonProcess } from "./processHost";
import { shellFor } from "./shell";
import type { Adapter, ProviderConfig, Reasoning } from "./types";

// Antigravity (Google's ACP agent) as a provider: the Tauri glue around the pure session code in antigravitySession.ts.
// The agent is started through the shared process host (graceful stop, process ledger) in a private profile folder
// (src-tauri/src/antigravity_profile.rs), so its Google sign-in belongs to this provider only. The API key of the key
// methods is read from the Keychain at first use and travels in the child's environment only: never in the script text,
// a URL, a log or a setting. Docs: docs/features/antigravity.md.

export type AuthState = { state: "signedIn" | "signedOut"; method: string; at: number };
const AUTH_SETTING = "antigravityAuth";
const PROBE_CWD_FALLBACK = ".";

const levelCache = new Map<string, Partial<Record<Reasoning, string>>>();
const ORDER: Reasoning[] = ["low", "medium", "high", "xhigh", "max"];

/** What the last sign-in, model listing or turn learned about the account; a status line only, never a credential. */
export async function authState(providerId: string): Promise<AuthState | undefined> {
  return (await getSetting<Record<string, AuthState>>(AUTH_SETTING, {}).catch(() => ({}) as Record<string, AuthState>))[
    providerId
  ];
}

async function recordAuth(providerId: string, state: AuthState["state"] | null, method = "") {
  try {
    const all = { ...(await getSetting<Record<string, AuthState>>(AUTH_SETTING, {})) };
    const old = all[providerId];
    if (old && state === old.state && method === old.method && Date.now() - old.at < 3_600_000) return;
    if (state === null) delete all[providerId];
    else all[providerId] = { state, method, at: Date.now() };
    await setSetting(AUTH_SETTING, all);
  } catch {
    /* the status line is advisory */
  }
}

const KEY_METHODS = new Set(["gemini-api-key", "agent-platform"]);

async function keyOf(cfg: ProviderConfig, key: KeySource, s: AntigravitySettings): Promise<string> {
  if (!KEY_METHODS.has(s.method)) return "";
  // A provider known to have no key never touches the Keychain (Agent Platform may use a project instead).
  if (typeof key !== "string" && (await secretPresence(providerSecretId(cfg.id))) === false) return "";
  return (await resolveKey(key)).trim();
}

/** Short non-reversible fingerprint of the key, so a changed key replaces the live process without keeping the key around. */
async function fingerprint(secret: string): Promise<string> {
  if (!secret) return "";
  try {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    return [...new Uint8Array(d).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "k";
  }
}

async function prepared(cfg: ProviderConfig, key: KeySource) {
  const settings = normalizeSettings(cfg.antigravity);
  if (!validBinary(settings.binary)) throw new AntigravityError("unavailable", "The binary path is not valid.");
  const apiKey = await keyOf(cfg, key, settings);
  const profile = await antigravityProfiles.prepare(cfg.id, profileSettingsJson(settings));
  const platform = currentPlatform();
  const env = launchEnv({
    geminiHome: profile.geminiHome,
    tempDir: profile.tempDir,
    method: settings.method,
    apiKey,
    platform,
  });
  const script = launchScript(shellFor(platform).kind, settings.binary);
  const deps: AgentDeps = {
    method: settings.method,
    secrets: () => (apiKey ? [apiKey] : []),
    open: async ({ cwd, onAuthUrl }) => {
      const onLine = (line: string) => {
        const url = authUrlFromLine(line);
        if (url) onAuthUrl(url);
      };
      const split = lineSplitter(onLine);
      // The agent reports a sign-in link on stdout (its own line) or stderr (the BROWSER helper); neither is logged.
      const proc = await openJsonProcess(script, { cwd, env, onRaw: onLine, onStderr: split });
      return proc;
    },
  };
  return { deps, settings, profile, apiKey };
}

const fallbackCwd = (profile: { tempDir: string }) => profile.tempDir || PROBE_CWD_FALLBACK;

/** The cheap health check: `initialize` only (never a login, no session, no MCP servers). */
export async function probeAntigravity(cfg: ProviderConfig, key: KeySource): Promise<Probe> {
  const p = await prepared(cfg, key);
  return probeAgent(p.deps, fallbackCwd(p.profile));
}

/** Opens a validated Google link in the OS browser (https, accounts.google.com sign-in only). */
export async function openAuthorizationUrl(url: string): Promise<void> {
  const safe = parseAuthorizationUrl(url);
  if (!safe) throw new AntigravityError("auth-failed", "Refusing to open a link that is not a Google sign-in page.");
  await openUrl(safe);
}

/** Explicit sign-in. `onUrl` gets the validated link (the caller opens it and shows "waiting for browser sign-in"). */
export async function signInAntigravity(
  cfg: ProviderConfig,
  key: KeySource,
  hooks: { onUrl: (url: string) => void; signal?: AbortSignal; timeoutMs?: number },
): Promise<SessionInfo> {
  const p = await prepared(cfg, key);
  try {
    const info = await signInAgent(p.deps, fallbackCwd(p.profile), cfg.id, hooks);
    levelCache.set(cfg.id, info.levels);
    await recordAuth(cfg.id, "signedIn", p.settings.method);
    return info;
  } catch (e) {
    if (e instanceof AntigravityError && e.code === "signin-required") await recordAuth(cfg.id, "signedOut");
    throw e;
  }
}

/** Sign out: the agent's own `logout` when it has one, then the private profile (token included) is deleted. */
export async function signOutAntigravity(cfg: ProviderConfig, key: KeySource): Promise<void> {
  try {
    const p = await prepared(cfg, key);
    await signOutAgent(p.deps, fallbackCwd(p.profile));
  } catch {
    /* not installed, or the agent has no logout: removing the profile below ends the sign-in anyway */
  }
  await antigravityProfiles.remove(cfg.id).catch(() => {});
  levelCache.delete(cfg.id);
  await recordAuth(cfg.id, "signedOut");
}

export function antigravityAdapter(cfg: ProviderConfig, key: KeySource): Adapter {
  const noteFailure = async (e: unknown, method: string) => {
    if (e instanceof AntigravityError && e.code === "signin-required") await recordAuth(cfg.id, "signedOut", method);
  };
  return {
    supportsComputer: false,
    supportsReasoning: () => Object.keys(levelCache.get(cfg.id) ?? {}).length > 0,
    reasoningLevels: () => ORDER.filter((l) => levelCache.get(cfg.id)?.[l]),

    async listModels() {
      const p = await prepared(cfg, key);
      try {
        const info = await listAgentModels(p.deps, fallbackCwd(p.profile), cfg.id);
        levelCache.set(cfg.id, info.levels);
        await recordAuth(cfg.id, "signedIn", p.settings.method);
        return info.models;
      } catch (e) {
        await noteFailure(e, p.settings.method);
        throw e;
      }
    },

    async turn(t) {
      const p = await prepared(cfg, key);
      const signature = JSON.stringify({
        binary: p.settings.binary ?? "",
        method: p.settings.method,
        project: p.settings.project ?? "",
        location: p.settings.location ?? "",
        key: await fingerprint(p.apiKey),
      });
      try {
        const out = await runAntigravityTurn(t, {
          ...p.deps,
          providerId: cfg.id,
          signature,
          fallbackCwd: fallbackCwd(p.profile),
        });
        void recordAuth(cfg.id, "signedIn", p.settings.method);
        return out;
      } catch (e) {
        await noteFailure(e, p.settings.method);
        throw e;
      }
    },
  };
}
