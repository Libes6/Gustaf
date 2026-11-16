import type {
  DesktopNativeBrowserBridge,
  DesktopNativeBrowserTabState,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createNativeBrowserTabs,
  nativeBrowserTabState,
  steppedZoomFactor,
  usesNativeBrowserTabs,
} from "./nativeBrowser";

const primary = "env-primary" as EnvironmentId;
const remote = "env-remote" as EnvironmentId;

describe("usesNativeBrowserTabs", () => {
  it.each([
    ["the shell's own server", true, true, primary, primary, true],
    ["the setting is off", true, false, primary, primary, false],
    ["no native bridge (web, mobile, Electron)", false, true, primary, primary, false],
    ["another environment", true, true, remote, primary, false],
    ["no primary environment yet", true, true, primary, null, false],
  ] as const)("%s", (_name, available, enabled, environmentId, primaryEnvironmentId, expected) => {
    expect(usesNativeBrowserTabs({ available, enabled, environmentId, primaryEnvironmentId })).toBe(
      expected,
    );
  });
});

const state = (overrides: Partial<DesktopNativeBrowserTabState>): DesktopNativeBrowserTabState => ({
  tabId: "tab",
  number: 3,
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  zoomFactor: 1.25,
  ...overrides,
});

describe("nativeBrowserTabState", () => {
  it.each([
    ["a loaded page", {}, { kind: "Success", url: "https://example.com/", title: "Example" }],
    [
      "a page still loading",
      { loading: true },
      { kind: "Loading", url: "https://example.com/", title: "Example" },
    ],
    ["a new tab", { url: "about:blank", loading: true }, { kind: "Idle" }],
    ["a view with no page", { url: "" }, { kind: "Idle" }],
  ] as const)("maps %s", (_name, overrides, navStatus) => {
    expect(nativeBrowserTabState(state(overrides), "dark", "now")).toMatchObject({
      tabId: "tab",
      webContentsId: 3,
      navStatus,
      canGoBack: true,
      canGoForward: false,
      zoomFactor: 1.25,
      colorScheme: "dark",
      capturing: false,
    });
  });
});

describe("steppedZoomFactor", () => {
  it.each([
    [1, 1, 1.1],
    [1, -1, 0.9],
    [5, 1, 5],
    [0.25, -1, 0.25],
    [1.3, 1, 1.5],
    [2, 0, 1],
  ] as const)("from %s by %s gives %s", (current, direction, expected) => {
    expect(steppedZoomFactor(current, direction)).toBe(expected);
  });
});

describe("createNativeBrowserTabs", () => {
  it("runs a tab's calls after its view exists and maps its state", async () => {
    const calls: string[] = [];
    let finishCreate = () => {};
    let emit: (state: DesktopNativeBrowserTabState) => void = () => {};
    const record =
      (name: string) =>
      async (...args: ReadonlyArray<unknown>) => {
        calls.push(`${name} ${JSON.stringify(args)}`);
      };
    const bridge = {
      createTab: (tabId: string) =>
        new Promise<void>((resolve) => {
          calls.push(`create ${tabId}`);
          finishCreate = resolve;
        }),
      closeTab: record("close"),
      present: record("present"),
      navigate: record("navigate"),
      goBack: record("back"),
      goForward: record("forward"),
      refresh: record("refresh"),
      hardReload: record("hardReload"),
      setZoomFactor: record("zoom"),
      setColorScheme: record("colorScheme"),
      openDevTools: record("devtools"),
      clearCookies: record("clearCookies"),
      clearCache: record("clearCache"),
      onStateChange: (listener: (state: DesktopNativeBrowserTabState) => void) => {
        const previous = emit;
        emit = (next) => {
          previous(next);
          listener(next);
        };
        return () => {};
      },
      onOpenLink: () => () => {},
    } satisfies DesktopNativeBrowserBridge;
    const tabs = createNativeBrowserTabs(bridge);
    const seen: Array<[string, string]> = [];
    tabs.onStateChange((tabId, mapped) => seen.push([tabId, mapped.colorScheme]));

    const created = tabs.createTab("a", { url: null, colorScheme: "light" });
    const navigated = tabs.navigate("a", "https://example.com/");
    const other = tabs.goBack("b");
    await other;
    expect(calls).toEqual(["create a", 'back ["b"]']);

    finishCreate();
    await Promise.all([created, navigated]);
    expect(calls.slice(2)).toEqual(['navigate ["a","https://example.com/"]']);

    emit(state({ tabId: "a", zoomFactor: 1.5 }));
    await tabs.zoomIn("a");
    expect(calls.at(-1)).toBe('zoom ["a",1.75]');
    expect(seen).toEqual([["a", "light"]]);
  });
});
