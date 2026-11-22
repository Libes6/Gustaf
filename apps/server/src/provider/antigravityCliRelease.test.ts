import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  antigravityCliArchiveEntry,
  fetchAntigravityCliRelease,
  parseAntigravityCliRelease,
} from "./antigravityCliRelease.ts";

const manifest = {
  version: "1.5.14",
  url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/darwin-arm/cli_mac_arm64.tar.gz",
  sha512: "ab".repeat(64),
};

it("accepts the official CLI package and rejects anything else", () => {
  expect(parseAntigravityCliRelease(manifest, "darwin", "arm64")).toMatchObject({
    version: "1.5.14",
    format: "tar.gz",
    executable: { name: "antigravity" },
    sha512: manifest.sha512,
  });
  expect(
    parseAntigravityCliRelease(
      {
        ...manifest,
        url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/windows-x64/cli_windows_x64.exe",
      },
      "win32",
      "x64",
    ),
  ).toMatchObject({ format: "executable", executable: { name: "agy.exe" } });
  expect(
    parseAntigravityCliRelease(
      { ...manifest, url: "https://example.com/cli_mac_arm64.tar.gz" },
      "darwin",
      "arm64",
    ),
  ).toBeNull();
  expect(parseAntigravityCliRelease(manifest, "freebsd", "x64")).toBeNull();
});

it("allows the CLI executable and its license files, and nothing else", () => {
  expect(antigravityCliArchiveEntry("antigravity\nLICENSE\n", "antigravity")).toBe(true);
  expect(antigravityCliArchiveEntry("./antigravity\n", "antigravity")).toBe(true);
  expect(antigravityCliArchiveEntry("../antigravity\n", "antigravity")).toBe(false);
  expect(antigravityCliArchiveEntry("bin/antigravity\n", "antigravity")).toBe(false);
  expect(antigravityCliArchiveEntry("LICENSE\n", "antigravity")).toBe(false);
});

it.effect("reads the latest release manifest for this machine", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const release = yield* fetchAntigravityCliRelease("darwin", "arm64").pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            urls.push(request.url);
            return HttpClientResponse.fromWeb(request, Response.json(manifest));
          }),
        ),
      ),
    );
    expect(urls).toEqual([
      "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json",
    ]);
    expect(release?.version).toBe("1.5.14");
  }),
);
