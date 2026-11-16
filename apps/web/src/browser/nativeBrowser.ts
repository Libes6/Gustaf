import {
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  type DesktopNativeBrowserBridge,
  type DesktopNativeBrowserTabState,
  type DesktopPreviewBridge,
  type DesktopPreviewColorScheme,
  type DesktopPreviewTabState,
  type EnvironmentId,
  PREVIEW_ZOOM_LEVELS,
} from "@t3tools/contracts";

/** What the preview UI asks of whichever host draws a tab on this computer. */
export type DesktopPreviewTabControls = Pick<
  DesktopPreviewBridge,
  | "navigate"
  | "goBack"
  | "goForward"
  | "refresh"
  | "hardReload"
  | "zoomIn"
  | "zoomOut"
  | "resetZoom"
  | "setColorScheme"
  | "openDevTools"
  | "clearCookies"
  | "clearCache"
  | "onStateChange"
>;

/**
 * The user's own tabs on the shell's own server render natively. Agent tabs are opened by the
 * server and stream; another environment's pages could not reach its localhost from here.
 */
export function usesNativeBrowserTabs(input: {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    input.available &&
    input.enabled &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  );
}

export function nativeBrowserTabState(
  state: DesktopNativeBrowserTabState,
  colorScheme: DesktopPreviewColorScheme,
  updatedAt: string,
): DesktopPreviewTabState {
  const blank = state.url === "" || state.url === "about:blank";
  return {
    tabId: state.tabId,
    webContentsId: state.number,
    navStatus: blank
      ? { kind: "Idle" }
      : { kind: state.loading ? "Loading" : "Success", url: state.url, title: state.title },
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    zoomFactor: state.zoomFactor,
    pictureInPicture: false,
    colorScheme,
    audioMuted: false,
    audible: false,
    controller: "human",
    capturing: false,
    updatedAt,
  };
}

/** The next zoom step, the same steps the server tabs use; 0 resets. */
export function steppedZoomFactor(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return DEFAULT_PREVIEW_ZOOM_FACTOR;
  const nearest = PREVIEW_ZOOM_LEVELS.reduce(
    (best, level, index) =>
      Math.abs(level - current) < Math.abs(PREVIEW_ZOOM_LEVELS[best]! - current) ? index : best,
    0,
  );
  const index = Math.min(Math.max(nearest + direction, 0), PREVIEW_ZOOM_LEVELS.length - 1);
  return PREVIEW_ZOOM_LEVELS[index]!;
}

export interface NativeBrowserTabs extends DesktopPreviewTabControls {
  readonly createTab: DesktopNativeBrowserBridge["createTab"];
  readonly closeTab: DesktopNativeBrowserBridge["closeTab"];
  readonly present: DesktopNativeBrowserBridge["present"];
  readonly onOpenLink: DesktopNativeBrowserBridge["onOpenLink"];
}

export function createNativeBrowserTabs(bridge: DesktopNativeBrowserBridge): NativeBrowserTabs {
  const zoomByTab = new Map<string, number>();
  const colorSchemeByTab = new Map<string, DesktopPreviewColorScheme>();
  const queueByTab = new Map<string, Promise<void>>();
  // One tab's calls run in order, so a navigation sent while the view is still being made waits.
  const inOrder =
    <Args extends ReadonlyArray<unknown>>(
      operation: (tabId: string, ...args: Args) => Promise<void>,
    ) =>
    (tabId: string, ...args: Args): Promise<void> => {
      const next = (queueByTab.get(tabId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => operation(tabId, ...args));
      queueByTab.set(tabId, next);
      void next
        .finally(() => {
          if (queueByTab.get(tabId) === next) queueByTab.delete(tabId);
        })
        .catch(() => undefined);
      return next;
    };
  bridge.onStateChange((state) => zoomByTab.set(state.tabId, state.zoomFactor));
  const zoom = (tabId: string, direction: -1 | 0 | 1) =>
    bridge.setZoomFactor(tabId, steppedZoomFactor(zoomByTab.get(tabId) ?? 1, direction));
  return {
    createTab: inOrder((tabId, input: Parameters<DesktopNativeBrowserBridge["createTab"]>[1]) => {
      if (input.colorScheme) colorSchemeByTab.set(tabId, input.colorScheme);
      return bridge.createTab(tabId, input);
    }),
    closeTab: inOrder((tabId) => {
      zoomByTab.delete(tabId);
      colorSchemeByTab.delete(tabId);
      return bridge.closeTab(tabId);
    }),
    present: inOrder(bridge.present),
    onOpenLink: bridge.onOpenLink,
    navigate: inOrder(bridge.navigate),
    goBack: inOrder(bridge.goBack),
    goForward: inOrder(bridge.goForward),
    refresh: inOrder(bridge.refresh),
    hardReload: inOrder(bridge.hardReload),
    zoomIn: inOrder((tabId) => zoom(tabId, 1)),
    zoomOut: inOrder((tabId) => zoom(tabId, -1)),
    resetZoom: inOrder((tabId) => zoom(tabId, 0)),
    setColorScheme: inOrder((tabId, colorScheme: DesktopPreviewColorScheme) => {
      colorSchemeByTab.set(tabId, colorScheme);
      return bridge.setColorScheme(tabId, colorScheme);
    }),
    openDevTools: inOrder(bridge.openDevTools),
    clearCookies: (_environmentId, profileId) => bridge.clearCookies(profileId),
    clearCache: (_environmentId, profileId) => bridge.clearCache(profileId),
    onStateChange: (listener) =>
      bridge.onStateChange((state) =>
        listener(
          state.tabId,
          nativeBrowserTabState(
            state,
            colorSchemeByTab.get(state.tabId) ?? "system",
            new Date().toISOString(),
          ),
        ),
      ),
  };
}

const nativeBrowserBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.nativeBrowser ?? null);

export const nativeBrowserTabs: NativeBrowserTabs | null = nativeBrowserBridge
  ? createNativeBrowserTabs(nativeBrowserBridge)
  : null;

/** Gustaf's shell with Chromium draws the server's own tabs, so the user and agents share them. */
export const nativeRendersServerTabs = nativeBrowserBridge?.rendersServerTabs === true;
