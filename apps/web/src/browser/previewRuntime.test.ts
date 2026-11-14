import type { EnvironmentId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { rendersServerTabNatively } from "./previewRuntime";

const env = "env-1" as EnvironmentId;

describe("rendersServerTabNatively", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "Electron host with the preview bridge",
      { desktopBridge: { preview: {} } },
      "server",
      false,
      true,
    ],
    ["Gustaf shell without the preview bridge", { desktopBridge: {} }, "server", false, false],
    ["plain browser", {}, "server", false, false],
    ["headless server tab", { desktopBridge: { preview: {} } }, "server", true, false],
    ["desktop-runtime tab", { desktopBridge: { preview: {} } }, "desktop", false, false],
  ] as const)("%s", (_name, win, runtime, headless, expected) => {
    vi.stubGlobal("window", win);
    expect(rendersServerTabNatively(env, env, { runtime, headless })).toBe(expected);
  });
});
