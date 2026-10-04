// Keychain access at startup: building adapters and showing model lists must not read API keys (macOS asks the user
// for every read); a key is read on the first request that needs it, once per session, and saving a key replaces the
// cached value. The Keychain (`secret_*`), settings and HTTP are in-memory fakes; `secret_get` calls are counted.
import { screen } from "@testing-library/react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebSettings } from "../../src/components/WebSettings";
import { invalidateSecret, readSecret } from "../../src/lib/keys";
import { deleteProvider, getAdapter, listAllModels, MODEL_TTL_MS, modelListLimits, resetModelState, saveProvider } from "../../src/providers";
import type { ProviderConfig, TurnInput } from "../../src/providers/types";
import { renderApp } from "./render";
import { callsOf, mockInvoke } from "./tauri";

const settings = new Map<string, string>();
const keychain = new Map<string, string>();

function backend() {
  mockInvoke({
    db_select: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/from settings where key/.test(sql)) {
        const v = settings.get(String(params[0]));
        return v === undefined ? [] : [{ value: v }];
      }
      return [];
    },
    db_execute: ({ sql, params }: { sql: string; params: unknown[] }) => {
      if (/insert into settings/.test(sql)) settings.set(String(params[0]), String(params[1]));
      return [1, 1];
    },
    secret_get: ({ id }: { id: string }) => keychain.get(id) ?? null,
    secret_set: ({ id, value }: { id: string; value: string }) => void keychain.set(id, value),
    secret_delete: ({ id }: { id: string }) => void keychain.delete(id),
  });
}
const setting = (key: string, value: unknown) => settings.set(key, JSON.stringify(value));
const reads = () => callsOf("secret_get").map((a) => a.id);

const openai: ProviderConfig = { id: "oa", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.test/v1" };
const claude: ProviderConfig = { id: "an", kind: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.test" };
const router: ProviderConfig = { id: "or", kind: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.test/v1" };
const ollama: ProviderConfig = { id: "ol", kind: "ollama", name: "Ollama", baseUrl: "http://localhost:11434/v1" };
const api = [openai, claude, router];
const model = (p: ProviderConfig, id: string) => ({ id, name: id, providerId: p.id, created: 0 });

const fetchMock = vi.mocked(tauriFetch);
/** Answers /models with one model per provider and chat completions with a short SSE stream; returns the request log. */
function http() {
  const log: { url: string; headers: Record<string, string> }[] = [];
  fetchMock.mockImplementation((async (url: string, init?: RequestInit) => {
    log.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (url.endsWith("/chat/completions")) {
      const body = ['{"choices":[{"delta":{"content":"OK"}}]}', '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}'].map((d) => `data: ${d}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    return new Response(JSON.stringify({ data: [{ id: `fresh-${new URL(url).host}` }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof tauriFetch);
  return log;
}
const turn = (): TurnInput => ({ system: "", messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }], tools: [], model: "m", signal: new AbortController().signal, onText: () => {} });

beforeEach(() => {
  settings.clear();
  keychain.clear();
  invalidateSecret();
  resetModelState();
  fetchMock.mockReset();
  backend();
  for (const p of api) keychain.set(`provider:${p.id}`, `key-${p.id}`);
  setting("providers", api);
});

describe("lazy API keys", () => {
  it("startup with cached lists reads no key and makes no request", async () => {
    const log = http();
    setting("modelCache", Object.fromEntries(api.map((p) => [p.id, { at: Date.now() - 24 * 3600_000, models: [model(p, `cached-${p.id}`)] }])));
    for (const p of api) await getAdapter(p);
    const { models, errors } = await listAllModels(api, "startup");
    expect(models.map((m) => m.id).sort()).toEqual(["cached-an", "cached-oa", "cached-or"]);
    expect(errors).toEqual({});
    expect(reads()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("first launch without a cache lists nothing for keyed providers until the picker opens; a keyless local server still lists", async () => {
    const log = http();
    setting("secretFlags", { "provider:ol": false });
    const { models } = await listAllModels([...api, ollama], "startup");
    expect(models.map((m) => m.id)).toEqual(["fresh-localhost:11434"]);
    expect(reads()).toEqual([]);
    expect(log.map((r) => r.url)).toEqual(["http://localhost:11434/v1/models"]);
    expect(log[0].headers.Authorization).toBeUndefined();
  });

  it("two sends read the key exactly once", async () => {
    const log = http();
    const a = await getAdapter(router);
    expect(reads()).toEqual([]);
    await a.turn(turn());
    await a.turn(turn());
    expect(reads()).toEqual(["provider:or"]);
    expect(log.map((r) => r.headers.Authorization)).toEqual(["Bearer key-or", "Bearer key-or"]);
  });

  it("concurrent first requests share one read", async () => {
    http();
    const a = await getAdapter(claude);
    // The fake answers /v1/messages with no stream, which the adapter retries: the turn is stopped once the lists are in.
    const ctl = new AbortController();
    const sent = a.turn({ ...turn(), signal: ctl.signal }).catch(() => {});
    await Promise.all([a.listModels(), a.listModels()]);
    ctl.abort();
    await sent;
    expect(reads()).toEqual(["provider:an"]);
  });

  it("saving a key replaces the cached one without reading the Keychain again; deleting forgets it", async () => {
    const log = http();
    await (await getAdapter(router)).turn(turn());
    await saveProvider(router, "new-key");
    await (await getAdapter(router)).turn(turn());
    expect(reads()).toEqual(["provider:or"]);
    expect(log.map((r) => r.headers.Authorization)).toEqual(["Bearer key-or", "Bearer new-key"]);
    expect(JSON.parse(settings.get("secretFlags")!)["provider:or"]).toBe(true);

    await deleteProvider(router.id);
    expect(keychain.has("provider:or")).toBe(false);
    expect(JSON.parse(settings.get("secretFlags")!)).not.toHaveProperty("provider:or");
  });

  it("an empty key is not stored and the provider never reads the Keychain", async () => {
    const log = http();
    const local: ProviderConfig = { id: "lm", kind: "lmstudio", name: "LM", baseUrl: "http://localhost:1234/v1" };
    await saveProvider(local, "");
    invalidateSecret();
    await (await getAdapter(local)).turn(turn());
    expect(keychain.has("provider:lm")).toBe(false);
    expect(reads()).toEqual([]);
    expect(log[0].headers.Authorization).toBeUndefined();
  });

  it("the picker refreshes stale lists once per 10 minutes; an explicit refresh always fetches", async () => {
    const log = http();
    const old = Date.now() - MODEL_TTL_MS - 1000;
    setting("modelCache", { oa: { at: old, models: [model(openai, "cached-oa")] }, an: { at: Date.now(), models: [model(claude, "cached-an")] } });
    const first = await listAllModels(api, "stale");
    // OpenAI (stale) and OpenRouter (never listed) are fetched; Anthropic's list is fresh enough.
    expect(log.map((r) => new URL(r.url).host).sort()).toEqual(["api.openai.test", "openrouter.test"]);
    expect(first.models.map((m) => m.id).sort()).toEqual(["cached-an", "fresh-api.openai.test", "fresh-openrouter.test"]);
    expect(reads().sort()).toEqual(["provider:oa", "provider:or"]);

    await listAllModels(api, "stale");
    expect(log).toHaveLength(2);
    // The fetched lists are what the next launch shows.
    const next = await listAllModels(api, "startup");
    expect(next.models.map((m) => m.id).sort()).toEqual(["cached-an", "fresh-api.openai.test", "fresh-openrouter.test"]);

    await listAllModels(api, "force", [claude.id]);
    expect(log.map((r) => new URL(r.url).host)).toContain("api.anthropic.test");
    expect(log).toHaveLength(3);
    expect(reads().sort()).toEqual(["provider:an", "provider:oa", "provider:or"]);
  });

  it("a failed refresh keeps the cached list and reports the error", async () => {
    fetchMock.mockImplementation((async () => new Response("{}", { status: 500 })) as unknown as typeof tauriFetch);
    setting("modelCache", { oa: { at: 0, models: [model(openai, "cached-oa")] } });
    const { models, errors } = await listAllModels([openai], "stale");
    expect(models.map((m) => m.id)).toEqual(["cached-oa"]);
    expect(errors.oa).toBeTruthy();
    // Not retried on every picker open.
    await listAllModels([openai], "stale");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a denied Keychain read names the key, records no 'absent' flag and is retried next time", async () => {
    const log = http();
    let deny = true;
    mockInvoke({ secret_get: ({ id }: { id: string }) => { if (deny) throw "User canceled the operation."; return keychain.get(id) ?? null; } });
    const a = await getAdapter(router);
    await expect(a.turn(turn())).rejects.toThrow(/OpenRouter from the Keychain: User canceled the operation\. Allow/);
    expect(log).toHaveLength(0);
    expect(JSON.parse(settings.get("secretFlags") ?? "{}")).not.toHaveProperty("provider:or");
    deny = false;
    await a.turn(turn());
    expect(log.map((r) => r.headers.Authorization)).toEqual(["Bearer key-or"]);
  });

  it("an adapter is rebuilt when its provider's settings changed elsewhere (e.g. in another window)", async () => {
    const log = http();
    await (await getAdapter(router)).listModels();
    await (await getAdapter({ ...router, baseUrl: "https://moved.test/v1" })).listModels();
    expect(log.map((r) => new URL(r.url).host)).toEqual(["openrouter.test", "moved.test"]);
    expect(await getAdapter(router)).toBe(await getAdapter({ ...router }));
  });

  it("saving a new key lets the picker refetch at once instead of waiting out the failed attempt", async () => {
    fetchMock.mockImplementation((async () => new Response("{}", { status: 401 })) as unknown as typeof tauriFetch);
    const first = await listAllModels([openai], "stale");
    expect(first.errors.oa).toBeTruthy();
    http();
    await saveProvider(openai, "fixed");
    const next = await listAllModels([openai], "stale");
    expect(next.errors).toEqual({});
    expect(next.models.map((m) => m.id)).toEqual(["fresh-api.openai.test"]);
  });

  it("a provider that never answers does not hold back the other lists", async () => {
    http();
    const answer = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(((url: string, init?: RequestInit) => (url.includes("openrouter") ? new Promise(() => {}) : answer(url, init))) as typeof tauriFetch);
    modelListLimits.timeoutMs = 20;
    try {
      const { models, errors } = await listAllModels(api, "force");
      expect(models.map((m) => m.id).sort()).toEqual(["fresh-api.anthropic.test", "fresh-api.openai.test"]);
      expect(errors.or).toMatch(/did not answer/);
    } finally {
      modelListLimits.timeoutMs = 30_000;
    }
  });

  it("readSecret caches a value but retries a missing one", async () => {
    keychain.set("mcp:s:env:TOKEN", "t");
    await readSecret("mcp:s:env:TOKEN");
    await readSecret("mcp:s:env:TOKEN");
    await readSecret("missing");
    await readSecret("missing");
    expect(reads()).toEqual(["mcp:s:env:TOKEN", "missing", "missing"]);
  });

  it("web settings show a saved Brave key from the presence flag without reading it", async () => {
    setting("secretFlags", { "web:brave": true });
    setting("webTools", { enabled: false, allow: [], deny: [] });
    renderApp(<WebSettings />);
    expect(await screen.findByRole("button", { name: "Remove key" })).toBeInTheDocument();
    expect(reads()).toEqual([]);
  });
});
