import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { useT } from "../useUiLanguage";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useWallpaperLibrary, wallpaperSceneId, type WallpaperOption } from "./wallpaperLibrary";
import { createWallpaperWatchdog } from "./wallpaperWatchdog";

const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");

function useSceneSource(wallpaper: WallpaperOption): string | null {
  const [fetched, setFetched] = useState<{ id: string; source: string } | null>(null);
  const t = useT();
  const failedTitle = t("wallpaper.sceneFailed");
  const builtInId = wallpaper.source === undefined ? wallpaper.id : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads a built-in scene's file from the app's static assets
  useEffect(() => {
    if (builtInId === null) return;
    const controller = new AbortController();
    void fetch(`${BASE_URL}/wallpapers/${builtInId}.js`, { signal: controller.signal })
      .then((response) => (response.ok ? response.text() : Promise.reject(response.status)))
      .then((source) => setFetched({ id: builtInId, source }))
      .catch(() => {
        if (!controller.signal.aborted)
          toastManager.add(stackedThreadToast({ type: "error", title: failedTitle }));
      });
    return () => controller.abort();
  }, [builtInId, failedTitle]);
  return wallpaper.source ?? (fetched?.id === wallpaper.id ? fetched.source : null);
}

/**
 * The live scene behind the conversation. Scenes are third-party code, so they draw inside a
 * sandboxed frame with an opaque origin and no network; this side only posts the scene and state.
 */
export function ChatWallpaper(props: { readonly working: boolean }) {
  const { active } = useWallpaperLibrary();
  return active ? (
    <WallpaperFrame key={active.id} wallpaper={active} working={props.working} />
  ) : null;
}

function WallpaperFrame(props: { readonly wallpaper: WallpaperOption; readonly working: boolean }) {
  const active = props.wallpaper;
  const source = useSceneSource(active);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  const t = useT();
  const failedTitle = t("wallpaper.sceneFailed");
  const stalledMessage = t("wallpaper.stalled");
  const activeId = active.id;
  const sky = active.sky;

  const notifyFailure = useStableCallback((message?: string) => {
    toastManager.add(
      stackedThreadToast({ type: "error", title: failedTitle, description: message }),
    );
  });
  const onStall = useStableCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ type: "wallpaper:stop" }, "*");
    notifyFailure(stalledMessage);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for errors from the sandboxed scene
  useEffect(() => {
    const watchdog = createWallpaperWatchdog(onStall);
    const onVisibility = () => {
      if (document.hidden || !document.hasFocus()) watchdog.stop();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      if (typeof event.data !== "object" || event.data === null) return;
      if (event.data.type === "wallpaper:watch") {
        if (event.data.active && !document.hidden && document.hasFocus()) watchdog.start();
        else watchdog.stop();
      }
      if (event.data.type === "wallpaper:frame") watchdog.frame();
      if (event.data.type === "wallpaper:error") {
        watchdog.stop();
        notifyFailure(typeof event.data.message === "string" ? event.data.message : undefined);
      }
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onVisibility);
    return () => {
      watchdog.stop();
      window.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onVisibility);
    };
  }, [notifyFailure, onStall]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts the scene to the sandboxed frame's window
  useEffect(() => {
    if (!ready || source === null) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: "wallpaper:scene", id: wallpaperSceneId(activeId), source, sky },
      "*",
    );
  }, [ready, activeId, source, sky]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pauses the frame's animation while the window is in the background
  useEffect(() => {
    if (!ready) return;
    const post = () =>
      frameRef.current?.contentWindow?.postMessage(
        {
          type: "wallpaper:state",
          working: props.working,
          paused: document.hidden || !document.hasFocus(),
        },
        "*",
      );
    post();
    document.addEventListener("visibilitychange", post);
    window.addEventListener("focus", post);
    window.addEventListener("blur", post);
    return () => {
      document.removeEventListener("visibilitychange", post);
      window.removeEventListener("focus", post);
      window.removeEventListener("blur", post);
    };
  }, [ready, props.working]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <iframe
        ref={frameRef}
        onLoad={() => setReady(true)}
        src={`${BASE_URL}/wallpaper-frame.html`}
        title={t("wallpaper.title")}
        tabIndex={-1}
        // Omitting allow-same-origin keeps scene code away from the session and its storage.
        sandbox="allow-scripts"
        className="absolute inset-0 size-full border-0"
      />
      <div className="absolute inset-0 bg-background/60" />
    </div>
  );
}
