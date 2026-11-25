import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
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
