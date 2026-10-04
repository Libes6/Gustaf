import { withComputer } from "./computerBridge";
import { cursorProfiles, db, getSetting, setSetting } from "../lib/api";
import { providerKey, providerSecretId, removeSecret, secretPresence, storeSecret, type KeySource } from "../lib/keys";
import { anthropic } from "./anthropic";
import { cliAdapter } from "./cli";
import { cursorAgent } from "./cursor";
import { openaiCompatible } from "./openaiCompatible";
import { openaiResponses } from "./openaiResponses";
import type { Adapter, ModelInfo, ProviderConfig, ProviderKind } from "./types";

export const PRESETS: Record<ProviderKind, { name: string; baseUrl: string; needsKey: boolean; keyUrl?: string }> = {
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  gemini: { name: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, keyUrl: "https://aistudio.google.com/api-keys" },
  anthropic: { name: "Anthropic", baseUrl: "https://api.anthropic.com", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, keyUrl: "https://openrouter.ai/keys" },
  ollama: { name: "Ollama", baseUrl: "http://localhost:11434/v1", needsKey: false },
  lmstudio: { name: "LM Studio", baseUrl: "http://localhost:1234/v1", needsKey: false },
  custom: { name: "Custom", baseUrl: "", needsKey: false },
  cursor: { name: "Cursor", baseUrl: "", needsKey: true, keyUrl: "https://cursor.com/dashboard/integrations" },
  cli: { name: "CLI", baseUrl: "", needsKey: false },
};

export const loadProviders = () => getSetting<ProviderConfig[]>("providers", []);

export async function saveProvider(cfg: ProviderConfig, key: string | null) {
  const list = await loadProviders();
  const i = list.findIndex((p) => p.id === cfg.id);
  const old = i >= 0 ? list[i] : undefined;
  if (i >= 0) list[i] = cfg;
  else list.push(cfg);
  // An empty key is not stored: the provider is then known to have none and never touches the Keychain.
  if (key) await storeSecret(providerSecretId(cfg.id), key);
  else if (key !== null) await removeSecret(providerSecretId(cfg.id));
  await setSetting("providers", list);
  adapters.delete(cfg.id);
  // A new key or endpoint makes the last failed listing (and its 10-minute throttle) moot; a list still in flight used the old one.
  if (key !== null || !old || old.baseUrl !== cfg.baseUrl) forgetModelState(cfg.id);
}

export async function deleteProvider(id: string) {
  const list = await loadProviders();
  // A browser-login Cursor account owns its isolated profile folder; it goes with the account.
  const profile = list.find((p) => p.id === id)?.cliProfile;
  if (profile) await cursorProfiles.remove(profile).catch(() => {});
  await setSetting("providers", list.filter((p) => p.id !== id));
  await removeSecret(providerSecretId(id), true);
  adapters.delete(id);
  forgetModelState(id);
  await writeModelCache((c) => (delete c[id], c));
}

function rawAdapter(cfg: ProviderConfig, key: KeySource): Adapter {
  if (cfg.kind === "openai") return openaiResponses(cfg, key);
  if (cfg.kind === "anthropic") return anthropic(cfg, key);
  if (cfg.kind === "cursor") return cursorAgent(cfg, key);
  if (cfg.kind === "cli") return cliAdapter(cfg, key);
  return openaiCompatible(cfg, key);
}

/** `key` is a fixed value (the "Test connection" form) or a lazy getter that reads the Keychain on first use. */
export function makeAdapter(cfg: ProviderConfig, key: KeySource): Adapter {
  return withComputer(rawAdapter(cfg, key), cfg.kind === "cli" || cfg.kind === "cursor");
}

const adapters = new Map<string, { cfg: string; adapter: Adapter }>();

/**
 * Building an adapter never reads the Keychain: its key is fetched (once per session) by the first request that needs it.
 * The adapter is rebuilt when the provider's settings differ from the ones it was built with (they may have been saved
 * in another window, which keeps its own adapters).
 */
export async function getAdapter(cfg: ProviderConfig) {
  const sig = JSON.stringify(cfg);
  let a = adapters.get(cfg.id);
  if (!a || a.cfg !== sig) {
    a = { cfg: sig, adapter: makeAdapter(cfg, providerKey(cfg.id, cfg.name)) };
    adapters.set(cfg.id, a);
  }
  return a.adapter;
}

// ---- model lists ---------------------------------------------------------------------------------------------------
// The last list of every provider is kept in the "modelCache" setting and shown at launch, so starting the app reads
// no API key. Fresh lists are fetched when the model picker opens (at most every MODEL_TTL_MS per provider) or on an
// explicit refresh. Providers that list without a key (CLIs, keyless local servers) still list at launch.

export type CachedModels = { at: number; models: ModelInfo[] };
const MODEL_CACHE = "modelCache";
export const MODEL_TTL_MS = 10 * 60_000;
/** "startup": cached lists (keyless providers fetch); "stale": fetch lists older than MODEL_TTL_MS; "force": fetch all. */
export type ModelRefresh = "startup" | "stale" | "force";

const modelErrors = new Map<string, string>();
const lastAttempt = new Map<string, number>();
const inflight = new Map<string, Promise<ModelInfo[]>>();
const forgetModelState = (id: string) => void (modelErrors.delete(id), lastAttempt.delete(id), inflight.delete(id));
let cacheWrites: Promise<unknown> = Promise.resolve();

const readModelCache = () => getSetting<Record<string, CachedModels>>(MODEL_CACHE, {}).catch(() => ({}) as Record<string, CachedModels>);
function writeModelCache(fn: (c: Record<string, CachedModels>) => Record<string, CachedModels>) {
  const run = cacheWrites.then(async () => setSetting(MODEL_CACHE, fn({ ...(await readModelCache()) })));
  cacheWrites = run.catch(() => {});
  return run.then(() => {}, () => {});
}

/** Whether listing this provider's models can never read a secret. */
async function listsWithoutKey(p: ProviderConfig) {
  if (p.kind === "cli") return p.cliAuth !== "key";
  if (p.kind === "ollama" || p.kind === "lmstudio" || p.kind === "custom") return (await secretPresence(providerSecretId(p.id))) === false;
  return false;
}

/** Test hook: forgets in-memory adapters and model-list state (errors, throttling). */
export const resetModelState = () => (modelErrors.clear(), lastAttempt.clear(), inflight.clear(), adapters.clear());

function fetchModels(p: ProviderConfig) {
  let run = inflight.get(p.id);
  if (!run) {
    lastAttempt.set(p.id, Date.now());
    run = getAdapter(p).then((a) => a.listModels()).finally(() => inflight.delete(p.id));
    inflight.set(p.id, run);
  }
  return run;
}

/**
 * Lists models (fresh or cached, see ModelRefresh) and records when each was first seen, which drives the NEW badge.
 * With `only`, "force" applies to those providers and the others are treated as at startup.
 */
export async function listAllModels(all: ProviderConfig[], refresh: ModelRefresh = "force", only?: string[]) {
  const providers = all.filter((p) => !p.disabled);
  const cache = await readModelCache();
  const now = Date.now();
  const wantsFetch = async (p: ProviderConfig) => {
    if (refresh === "force" && (!only || only.includes(p.id))) return true;
    const mode = refresh === "force" ? "startup" : refresh;
    if (await listsWithoutKey(p)) return mode === "startup" || !cache[p.id] || now - cache[p.id].at >= MODEL_TTL_MS;
    if (mode === "startup") return false;
    // A failed attempt counts too, so an unreachable provider is not retried every time the picker opens.
    return now - Math.max(cache[p.id]?.at ?? 0, lastAttempt.get(p.id) ?? 0) >= MODEL_TTL_MS;
  };
  const fetched = new Map<string, ModelInfo[]>();
  await Promise.all(
    providers.map(async (p) => {
      if (!(await wantsFetch(p))) return;
      try {
        fetched.set(p.id, await fetchModels(p));
        modelErrors.delete(p.id);
      } catch (e: any) {
        modelErrors.set(p.id, String(e?.message ?? e));
      }
    }),
  );
  if (fetched.size) {
    const at = Date.now();
    await writeModelCache((c) => {
      for (const [id, models] of fetched) c[id] = { at, models };
      return c;
    });
  }
  const seen = new Map(
    (await db.select<{ provider: string; model: string; first_seen: number }>("select * from models_seen")).map((r) => [
      `${r.provider}\n${r.model}`,
      r.first_seen,
    ]),
  );
  const models: (ModelInfo & { firstSeen: number })[] = [];
  for (const p of providers) {
    const fresh = fetched.get(p.id);
    const firstRun = ![...seen.keys()].some((k) => k.startsWith(`${p.id}\n`));
    for (const m of fresh ?? cache[p.id]?.models ?? []) {
      let first = seen.get(`${m.providerId}\n${m.id}`);
      if (first === undefined) {
        // On the first listing of a provider, nothing is "new" except genuinely recent models.
        first = firstRun ? Math.min(now, m.created || 0) : now;
        if (fresh) await db.exec("insert or ignore into models_seen(provider, model, first_seen) values(?, ?, ?)", [m.providerId, m.id, first]);
      }
      models.push({ ...m, firstSeen: first });
    }
  }
  const errors: Record<string, string> = {};
  for (const p of providers) {
    const e = modelErrors.get(p.id);
    if (e) errors[p.id] = e;
  }
  return { models, errors };
}

/** Pings the default local ports; returns the kinds that answered. */
export async function detectLocal(): Promise<ProviderKind[]> {
  const { fetch } = await import("./http");
  const probe = async (kind: ProviderKind) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 800);
    try {
      const r = await fetch(`${PRESETS[kind].baseUrl}/models`, { signal: ctl.signal });
      return r.ok ? kind : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  return (await Promise.all([probe("ollama"), probe("lmstudio")])).filter(Boolean) as ProviderKind[];
}
