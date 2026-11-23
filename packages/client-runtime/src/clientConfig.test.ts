import { describe, expect, it } from "vite-plus/test";

import {
  announcementText,
  createClientConfigStore,
  decodeClientConfig,
  isFeatureEnabled,
} from "./clientConfig.ts";

const config = (overrides: Record<string, unknown> = {}) => ({
  announcements: [
    { id: "a", level: "warning", text: { en: "Hi", ru: "Привет" }, link: null },
    { id: "b", level: "info", text: { en: "B", ru: "Б" }, link: "https://example.test" },
  ],
  update: { required: true, minimumVersion: "1.5.0", message: null },
  flags: { beta: true, off: false },
  ...overrides,
});

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe("decodeClientConfig", () => {
  it("keeps valid entries and drops malformed ones", () => {
    const decoded = decodeClientConfig(
      config({
        announcements: [
          { id: "ok", level: "loud", text: { en: "x", ru: "y" }, link: "javascript:alert(1)" },
          { id: "no-text" },
          "junk",
        ],
        flags: { on: true, weird: "yes" },
      }),
    );
    expect(decoded?.announcements).toEqual([
      { id: "ok", level: "info", text: { en: "x", ru: "y" }, link: null },
    ]);
    expect(decoded?.flags).toEqual({ on: true });
    expect(decodeClientConfig("nope")).toBeNull();
    expect(decodeClientConfig({})?.update.required).toBe(false);
  });

  it("picks the announcement language and treats unknown flags as off", () => {
    const decoded = decodeClientConfig(config())!;
    expect(announcementText(decoded.announcements[0]!, "ru-RU")).toBe("Привет");
    expect(announcementText(decoded.announcements[0]!, "en")).toBe("Hi");
    expect(isFeatureEnabled(decoded, "beta")).toBe(true);
    expect(isFeatureEnabled(decoded, "off")).toBe(false);
    expect(isFeatureEnabled(decoded, "missing")).toBe(false);
  });
});

describe("createClientConfigStore", () => {
  it("serves the cached config of the same version and keeps it when the fetch fails", async () => {
    const storage = memoryStorage({
      "gustaf.clientConfig.v1": JSON.stringify({ version: "1.4.0", config: config() }),
    });
    const store = createClientConfigStore({
      version: "1.4.0",
      storage,
      fetchConfig: () => Promise.reject(new Error("offline")),
    });
    await store.restore();
    await store.refresh();
    expect(store.getSnapshot().config.update.required).toBe(true);
    expect(store.getSnapshot().announcements.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("ignores a cache written by another app version", async () => {
    const storage = memoryStorage({
      "gustaf.clientConfig.v1": JSON.stringify({ version: "1.4.0", config: config() }),
    });
    const store = createClientConfigStore({
      version: "1.5.0",
      storage,
      fetchConfig: () => Promise.reject(new Error("offline")),
    });
    await store.restore();
    expect(store.getSnapshot().config.update.required).toBe(false);
  });

  it("caches a fetched config and remembers dismissals across restarts", async () => {
    const storage = memoryStorage();
    const first = createClientConfigStore({
      version: "1.4.0",
      storage,
      fetchConfig: async () => config(),
    });
    let notified = 0;
    first.subscribe(() => notified++);
    await first.restore();
    await first.refresh();
    first.dismiss("a");
    expect(first.getSnapshot().announcements.map((item) => item.id)).toEqual(["b"]);
    expect(notified).toBeGreaterThan(0);

    const second = createClientConfigStore({
      version: "1.4.0",
      storage,
      fetchConfig: () => Promise.reject(new Error("offline")),
    });
    await second.restore();
    expect(second.getSnapshot().announcements.map((item) => item.id)).toEqual(["b"]);
    expect(isFeatureEnabled(second.getSnapshot().config, "beta")).toBe(true);
  });

  it("keeps working when storage throws", async () => {
    const store = createClientConfigStore({
      version: "1.4.0",
      storage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => Promise.reject(new Error("denied")),
      },
      fetchConfig: async () => config(),
    });
    await store.restore();
    await store.refresh();
    store.dismiss("b");
    expect(store.getSnapshot().announcements.map((item) => item.id)).toEqual(["a"]);
  });
});
