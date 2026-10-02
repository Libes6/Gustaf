import { withComputer } from "./computerBridge";
import { db, getSetting, secrets, setSetting } from "../lib/api";
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
  if (i >= 0) list[i] = cfg;
  else list.push(cfg);
  if (key !== null) await secrets.set(`provider:${cfg.id}`, key);
  await setSetting("providers", list);
  adapters.delete(cfg.id);
}

export async function deleteProvider(id: string) {
  await setSetting("providers", (await loadProviders()).filter((p) => p.id !== id));
  await secrets.delete(`provider:${id}`);
  adapters.delete(id);
}

function rawAdapter(cfg: ProviderConfig, key: string): Adapter {
  if (cfg.kind === "openai") return openaiResponses(cfg, key);
  if (cfg.kind === "anthropic") return anthropic(cfg, key);
  if (cfg.kind === "cursor") return cursorAgent(cfg, key);
  if (cfg.kind === "cli") return cliAdapter(cfg, key);
  return openaiCompatible(cfg, key);
}

export function makeAdapter(cfg: ProviderConfig, key: string): Adapter {
  return withComputer(rawAdapter(cfg, key), cfg.kind === "cli" || cfg.kind === "cursor");
}

const adapters = new Map<string, Adapter>();

export async function getAdapter(cfg: ProviderConfig) {
  let a = adapters.get(cfg.id);
  if (!a) {
    a = makeAdapter(cfg, (await secrets.get(`provider:${cfg.id}`)) ?? "");
    adapters.set(cfg.id, a);
  }
  return a;
}

/** Lists models and records when each was first seen, which drives the NEW badge. */
export async function listAllModels(all: ProviderConfig[]) {
  const providers = all.filter((p) => !p.disabled);
  const results = await Promise.allSettled(providers.map(async (p) => (await getAdapter(p)).listModels()));
  const models: (ModelInfo & { firstSeen: number })[] = [];
  const now = Date.now();
  const seen = new Map(
    (await db.select<{ provider: string; model: string; first_seen: number }>("select * from models_seen")).map((r) => [
      `${r.provider}\n${r.model}`,
      r.first_seen,
    ]),
  );
  const errors: Record<string, string> = {};
  for (const [i, r] of results.entries()) {
    if (r.status === "rejected") {
      errors[providers[i].id] = String(r.reason?.message ?? r.reason);
      continue;
    }
    const firstRun = ![...seen.keys()].some((k) => k.startsWith(`${providers[i].id}\n`));
    for (const m of r.value) {
      let first = seen.get(`${m.providerId}\n${m.id}`);
      if (first === undefined) {
        // On the first listing of a provider, nothing is "new" except genuinely recent models.
        first = firstRun ? Math.min(now, m.created || 0) : now;
        await db.exec("insert or ignore into models_seen(provider, model, first_seen) values(?, ?, ?)", [m.providerId, m.id, first]);
      }
      models.push({ ...m, firstSeen: first });
    }
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
