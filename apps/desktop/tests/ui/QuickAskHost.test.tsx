import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQuickAskStatus, resetQuickAskStatus, useQuickAskHost } from "../../src/lib/quickAskHost";
import { setPlatformForTests } from "../../src/lib/platform";
import { mockSettings } from "./tauri";

const bus = vi.hoisted(() => ({
  usage: undefined as undefined | ((e: any) => void),
  open: undefined as undefined | ((e: any) => void),
}));
vi.mock("../../src/lib/quickAskApi", () => ({
  quickAskApi: {
    configure: vi.fn(async () => {}),
    onUsage: vi.fn(async (cb: (e: any) => void) => ((bus.usage = cb), () => {})),
    onOpenChat: vi.fn(async (cb: (e: any) => void) => ((bus.open = cb), () => {})),
  },
}));
import { quickAskApi } from "../../src/lib/quickAskApi";

function Host({ app }: { app: Parameters<typeof useQuickAskHost>[0] }) {
  useQuickAskHost(app);
  return null;
}
const makeApp = () => ({
  ready: true,
  recordTokens: vi.fn(),
  bumpUsage: vi.fn(),
  recordProviderResult: vi.fn(),
  reload: vi.fn(async () => {}),
  openChat: vi.fn(),
});

beforeEach(() => {
  setPlatformForTests("macos");
  resetQuickAskStatus();
});
afterEach(() => setPlatformForTests(undefined));

describe("useQuickAskHost (main window)", () => {
  it("registers nothing at startup while the feature is off", async () => {
    mockSettings({});
    render(<Host app={makeApp()} />);
    await waitFor(() => expect(quickAskApi.onUsage).toHaveBeenCalled());
    expect(quickAskApi.configure).not.toHaveBeenCalled();
    expect(getQuickAskStatus()).toEqual({ state: "off" });
  });

  it("registers the stored shortcut at startup when it is on", async () => {
    mockSettings({ quickAsk: { enabled: true, accelerator: null, hideOnBlur: true } });
    render(<Host app={makeApp()} />);
    await waitFor(() => expect(quickAskApi.configure).toHaveBeenCalledWith(true, "Command+Shift+Alt+Space", true));
    await waitFor(() => expect(getQuickAskStatus()).toEqual({ state: "on", accelerator: "Command+Shift+Alt+Space" }));
  });

  it("a shortcut that cannot be registered becomes an error status, not a crash", async () => {
    mockSettings({ quickAsk: { enabled: true, accelerator: "Alt+K", hideOnBlur: true } });
    vi.mocked(quickAskApi.configure).mockRejectedValueOnce("shortcut_unavailable: taken");
    render(<Host app={makeApp()} />);
    await waitFor(() =>
      expect(getQuickAskStatus()).toEqual({ state: "error", message: "shortcut_unavailable: taken" }),
    );
  });

  it("records the usage the quick-ask window reports like a normal run", async () => {
    mockSettings({});
    const app = makeApp();
    render(<Host app={app} />);
    await waitFor(() => expect(bus.usage).toBeDefined());
    const usage = { input: 1, output: 2, cached: 0, cacheWrite: 0, reasoning: 0 };
    bus.usage!({ providerId: "p1", model: "m1", usage });
    bus.usage!({ providerId: "p1", model: "m1", error: "HTTP 500" });
    expect(app.bumpUsage).toHaveBeenCalledTimes(2);
    expect(app.recordTokens).toHaveBeenNthCalledWith(1, "p1", "m1", usage);
    expect(app.recordProviderResult).toHaveBeenNthCalledWith(1, "p1", undefined);
    expect(app.recordProviderResult).toHaveBeenNthCalledWith(2, "p1", "HTTP 500");
  });

  it("opens the chat the quick-ask window stored, as a chat without a project, after reloading the list", async () => {
    mockSettings({});
    const app = makeApp();
    render(<Host app={app} />);
    await waitFor(() => expect(bus.open).toBeDefined());
    bus.open!({ chatId: 42 });
    await waitFor(() => expect(app.openChat).toHaveBeenCalledWith(42, null));
    expect(app.reload.mock.invocationCallOrder[0]).toBeLessThan(app.openChat.mock.invocationCallOrder[0]);
  });
});
