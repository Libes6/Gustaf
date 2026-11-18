import { describe, expect, it } from "vite-plus/test";

import { parsePackageJsonScripts } from "./useT3ProjectFileScripts";

describe("parsePackageJsonScripts", () => {
  it("uses the declared package manager and hides implicit pre/post hooks", () => {
    const contents = JSON.stringify({
      packageManager: "pnpm@9.1.0",
      scripts: { dev: "vite", build: "tsc", prebuild: "clean", postinstall: "x", empty: "" },
    });
    expect(parsePackageJsonScripts(contents)).toEqual([
      { name: "dev", command: "pnpm run dev" },
      { name: "build", command: "pnpm run build" },
      { name: "postinstall", command: "pnpm run postinstall" },
    ]);
  });

  it("falls back to npm and tolerates invalid input", () => {
    expect(parsePackageJsonScripts('{"scripts":{"test":"vitest"}}')).toEqual([
      { name: "test", command: "npm run test" },
    ]);
    expect(parsePackageJsonScripts("not json")).toEqual([]);
  });
});
