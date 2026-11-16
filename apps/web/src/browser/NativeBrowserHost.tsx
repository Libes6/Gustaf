import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { useClientSettingsHydrated } from "~/hooks/useSettings";
import {
  readActivePreviewSessions,
  type ThreadPreviewState,
  useActivePreviewSessions,
} from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { useEnvironmentScope } from "~/state/session";

import { resolveBrowserDefaults } from "./browserDefaults";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { useTabProfileId } from "./ElectronBrowserHost";
import { type NativeBrowserTabs, nativeBrowserTabs } from "./nativeBrowser";
import { usePageCoversNativeBrowser } from "./nativeBrowserOcclusion";
import { openUrlInPreview } from "./openFileInPreview";
import { rendersServerTabNatively } from "./previewRuntime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

/** The desktop-runtime tabs of the shell's own server, which this window draws natively. */
function nativeBrowserSessions(
  previewByThreadKey: Record<string, ThreadPreviewState>,
  primaryEnvironmentId: EnvironmentId | null,
) {
  return Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
    const threadRef = parseScopedThreadKey(threadKey);
    if (!threadRef || threadRef.environmentId !== primaryEnvironmentId) return [];
    return Object.values(previewState.sessions)
      .filter(
        (snapshot) =>
          snapshot.runtime !== "server" ||
          rendersServerTabNatively(threadRef.environmentId, primaryEnvironmentId, snapshot),
      )
      .map((snapshot) => ({
        threadRef,
        snapshot,
        runtimeTabId: previewRuntimeTabId(threadRef, previewState.serverEpoch, snapshot.tabId),
      }));
  });
}

/** Gustaf's macOS shell: the user's tabs as native web views over their slots. */
export function NativeBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to links a native tab asks to open in a new window
  useEffect(() => {
    if (!nativeBrowserTabs) return;
    return nativeBrowserTabs.onOpenLink(({ tabId, url }) => {
      const source = nativeBrowserSessions(
        readActivePreviewSessions(),
        appAtomRegistry.get(primaryEnvironmentIdAtom),
      ).find((session) => session.runtimeTabId === tabId);
      if (!source) return;
      void openUrlInPreview({
        threadRef: source.threadRef,
        url,
        openPreview: (input) => runAtomCommand(appAtomRegistry, previewEnvironment.open, input),
        profileId: source.snapshot.profileId,
      });
    });
  }, []);

  const tabs = nativeBrowserTabs;
  if (!tabs) return null;
  return nativeBrowserSessions(previewByThreadKey, primaryEnvironmentId).map(
    ({ threadRef, snapshot, runtimeTabId }) => (
      <AuthorizedNativeBrowserTab
        key={runtimeTabId}
        tabs={tabs}
        threadRef={threadRef}
        tabId={snapshot.tabId}
        runtimeTabId={runtimeTabId}
        initialUrl={snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url}
        profileId={snapshot.profileId}
        serverTab={snapshot.runtime === "server"}
      />
    ),
  );
}

interface NativeBrowserTabProps {
  readonly tabs: NativeBrowserTabs;
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly initialUrl: string | null;
  readonly profileId: string | undefined;
  /** The server owns the page; the shell only draws it. */
  readonly serverTab: boolean;
}

function AuthorizedNativeBrowserTab(props: NativeBrowserTabProps) {
  const canOperatePreview = useEnvironmentScope(
    props.threadRef.environmentId,
    AuthPreviewOperateScope,
  );
  const profileId = useTabProfileId(props.profileId);
  return canOperatePreview ? <NativeBrowserTab {...props} profileId={profileId} /> : null;
}

function NativeBrowserTab({
  tabs,
  threadRef,
  tabId,
  runtimeTabId,
  initialUrl,
  profileId,
  serverTab,
}: NativeBrowserTabProps) {
  const hydrated = useClientSettingsHydrated();
  const [initialSrc] = useState(initialUrl);
  const [created, setCreated] = useState(false);
  const covered = usePageCoversNativeBrowser();
  const { rect, visible, cornerRadius } = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        rect: current?.rect ?? null,
        visible: current?.visible ?? false,
        cornerRadius: current?.cornerRadius ?? 0,
      };
    }),
  );
  // A server tab's state comes from the server, which drives the page.
  usePreviewBridge({ threadRef, tabId, runtimeTabId, bridge: serverTab ? null : tabs });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the native view lives in the shell for as long as this tab is mounted
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void (async () => {
      const defaults = await resolveBrowserDefaults();
      await tabs.createTab(runtimeTabId, {
        url: initialSrc,
        profileId,
        zoomFactor: defaults.zoomFactor,
        colorScheme: defaults.appearance,
        ...(serverTab ? { serverTab: { threadId: threadRef.threadId, tabId } } : {}),
      });
      if (!cancelled) setCreated(true);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      setCreated(false);
      void tabs.closeTab(runtimeTabId).catch(() => undefined);
    };
  }, [hydrated, initialSrc, profileId, runtimeTabId, serverTab, tabId, tabs, threadRef.threadId]);

  const shown = created && visible && rect !== null && !covered;
  const x = rect?.x ?? 0;
  const y = rect?.y ?? 0;
  const width = rect?.width ?? 0;
  const height = rect?.height ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- places the native view over the slot the page measured, or hides it
  useEffect(() => {
    if (!created) return;
    const present = () =>
      void tabs
        .present(runtimeTabId, shown ? { rect: { x, y, width, height }, cornerRadius } : null)
        .catch(() => undefined);
    present();
    if (!shown) return;
    // AppKit keeps a child view's distance from the window's bottom, so a taller window moves it.
    window.addEventListener("resize", present);
    return () => window.removeEventListener("resize", present);
  }, [cornerRadius, created, height, runtimeTabId, shown, tabs, width, x, y]);

  return null;
}
