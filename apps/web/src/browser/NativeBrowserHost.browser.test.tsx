import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";

import { act, render } from "../../test/render";
import type { NativeBrowserTabs } from "./nativeBrowser";

const mocks = vi.hoisted(() => ({
  resolveBrowserDefaults: vi.fn(),
  createTab: vi.fn(async () => {}),
  closeTab: vi.fn(async () => {}),
}));

vi.mock(import("./browserDefaults"), async (original) => ({
  ...(await original()),
  resolveBrowserDefaults: mocks.resolveBrowserDefaults,
}));
vi.mock(import("./nativeBrowser"), async (original) => ({
  ...(await original()),
  nativeRendersServerTabs: true,
  nativeBrowserTabs: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    onOpenLink: () => () => {},
  } as unknown as NativeBrowserTabs,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettingsHydrated: () => true,
}));
vi.mock(import("~/state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make(() => EnvironmentId.make("local")),
  };
});
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/components/preview/usePreviewBridge"), () => ({ usePreviewBridge: () => {} }));
vi.mock(import("./ElectronBrowserHost"), () => ({ useTabProfileId: () => undefined }));
vi.mock(import("./nativeBrowserOcclusion"), () => ({ usePageCoversNativeBrowser: () => false }));

import { NativeBrowserHost } from "./NativeBrowserHost";

it("does not create a native tab after it closes while defaults are loading", async () => {
  let finishDefaults!: () => void;
  const defaults = new Promise((resolve) => {
    finishDefaults = () => resolve({ zoomFactor: 1, appearance: "system" });
  });
  mocks.resolveBrowserDefaults.mockReset().mockReturnValue(defaults);
  mocks.createTab.mockClear();
  mocks.closeTab.mockClear();
  using _state = { [Symbol.dispose]: resetPreviewStateForTests };
  const thread = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("native-browser"));
  reconcilePreviewServerSessions(thread, {
    sessions: [
      {
        threadId: thread.threadId,
        tabId: "tab",
        navStatus: { _tag: "Idle" },
        canGoBack: false,
        canGoForward: false,
        runtime: "server",
        updatedAt: "2026-11-18T00:00:00Z",
      },
    ],
    serverEpoch: "test-server",
    revision: 1,
  });

  await using screen = await render(
    <AppAtomRegistryProvider>
      <NativeBrowserHost />
    </AppAtomRegistryProvider>,
  );
  expect(mocks.resolveBrowserDefaults).toHaveBeenCalledOnce();
  await screen.rerender(<></>);
  await act(finishDefaults);
  expect(mocks.closeTab).toHaveBeenCalledOnce();
  expect(mocks.createTab).not.toHaveBeenCalled();
});
