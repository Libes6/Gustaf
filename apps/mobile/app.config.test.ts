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
  },
);

// Gustaf has no hosted web app, Expo update service or EAS project: a build must not
// claim T3's domains or point at their services.
it("carries nothing that belongs to T3's services", async () => {
  const config = await loadConfig(undefined);
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toBeUndefined();
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
  expect(config.owner).toBeUndefined();
  expect(config.extra?.eas?.projectId).toBeUndefined();
  expect(JSON.stringify(config)).not.toMatch(/t3\.codes|pingdotgg|com\.t3tools/);
});

it("takes the app version and versionCode from the release tag", async () => {
  vi.stubEnv("GUSTAF_VERSION_NAME", "v0.11.2");
  const config = await loadConfig("production");
  expect(config.version).toBe("0.11.2");
  expect(config.android?.versionCode).toBe(1102);
});
