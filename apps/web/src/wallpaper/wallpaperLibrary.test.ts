import { describe, expect, it } from "vite-plus/test";
import { parseWallpaperInstall, resolveWallpaperSceneUrl } from "./wallpaperLibrary";

describe("wallpaper imports", () => {
  it("reads scene registrations and optional metadata without executing the code", () => {
    for (const registration of ["SCENES.koi", "SCENES['koi']", 'SCENES["koi"]']) {
      const source = `${registration} = { cell() {} }; throw new Error("must not execute");`;
      expect(
        parseWallpaperInstall([
          { name: "koi.js", text: source },
          {
            name: "theme.json",
            text: JSON.stringify({
              name: "My pond",
              vars: { "wall-sky": "linear-gradient(red, blue)" },
            }),
          },
        ]),
      ).toEqual({
        ok: true,
        wallpaper: {
          id: "installed:koi",
          name: "My pond",
          sky: "linear-gradient(red, blue)",
          source,
        },
      });
    }
  });

  it("rejects unsupported and oversized inputs and ignores unsafe backgrounds", () => {
    expect(parseWallpaperInstall([])).toEqual({ ok: false, reason: "no-scene" });
    expect(parseWallpaperInstall([{ name: "mod.js", text: "export default {}" }])).toEqual({
      ok: false,
      reason: "not-a-scene",
    });
    expect(parseWallpaperInstall([{ name: "big.js", text: "x".repeat(200_001) }])).toEqual({
      ok: false,
      reason: "too-large",
    });
    for (const metadata of [
      "broken",
      '{"vars":null}',
      JSON.stringify({ vars: { "wall-sky": "url(https://example.com)" } }),
    ]) {
      const result = parseWallpaperInstall([
        { name: "cloud.mjs", text: "SCENES['cloud-drift'] = {}" },
        { name: "theme.json", text: metadata },
      ]);
      expect(result).toMatchObject({ ok: true, wallpaper: { name: "Cloud Drift" } });
      if (result.ok) expect(result.wallpaper.sky).toBeUndefined();
    }
  });

  it("resolves HTTPS scene links and refuses repository pages and credentialed URLs", () => {
    expect(
      resolveWallpaperSceneUrl(
        "https://github.com/owner/repo/blob/main/extension/src/scenes/koi.js",
      )?.href,
    ).toBe("https://raw.githubusercontent.com/owner/repo/main/extension/src/scenes/koi.js");
    expect(resolveWallpaperSceneUrl("https://example.com/scene.js")?.href).toBe(
      "https://example.com/scene.js",
    );
    for (const url of [
      "bad",
      "file:///tmp/scene.js",
      "http://example.com/scene.js",
      "https://user:password@example.com/scene.js",
      "https://github.com/owner/repo",
    ]) {
      expect(resolveWallpaperSceneUrl(url)).toBeNull();
    }
  });
});
