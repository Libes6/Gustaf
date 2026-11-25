import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    // app.config copies this back into process.env, where undefined would become "undefined".
    ...(process.env.GUSTAF_VERSION_NAME
      ? { GUSTAF_VERSION_NAME: process.env.GUSTAF_VERSION_NAME }
      : {}),
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "io.github.libes6.gustaf", "gustaf"],
  ["development", "io.github.libes6.gustaf.dev", "gustaf-dev"],
  ["preview", "io.github.libes6.gustaf.preview", "gustaf-preview"],
  ["production", "io.github.libes6.gustaf", "gustaf"],
])(
  "keeps the iOS and Android identifiers for APP_VARIANT=%j",
  async (value, identifier, scheme) => {
    const config = await loadConfig(value);
    expect(config.ios?.bundleIdentifier).toBe(identifier);
    expect(config.android?.package).toBe(identifier);
    expect(config.scheme).toBe(scheme);
    // Gustaf has no hosted site: links open the app through its scheme alone.
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
  },
);

it("keeps over-the-air updates off unless a build names its own server", async () => {
  expect((await loadConfig("production")).updates).toEqual({ enabled: false });

  vi.stubEnv("GUSTAF_MOBILE_UPDATES_URL", "https://updates.example.test/manifest");
  expect((await loadConfig("production")).updates).toMatchObject({
    enabled: true,
    url: "https://updates.example.test/manifest",
  });
});

it("takes the app version and versionCode from the release tag", async () => {
  vi.stubEnv("GUSTAF_VERSION_NAME", "v0.11.2");
  const config = await loadConfig("production");
  expect(config.version).toBe("0.11.2");
  expect(config.android?.versionCode).toBe(1102);
});

it("keeps the default version and no versionCode outside a release build", async () => {
  const config = await loadConfig("production");
  expect(config.android?.versionCode).toBeUndefined();
});

it("gives expo-observe a project id, since it throws at startup without one", async () => {
  const config = await loadConfig("production");
  const projectId = config.extra?.eas?.projectId;
  expect(typeof projectId === "string" && projectId.length > 0).toBe(true);
  expect(projectId).not.toBe("d763fcb8-d37c-41ea-a773-b54a0ab4a454");
  expect(config.extra?.eas?.observe?.endpointUrl).toBe("https://observe.invalid");
});
