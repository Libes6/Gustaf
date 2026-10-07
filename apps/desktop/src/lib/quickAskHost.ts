// Main-window side of the quick-ask feature: registers the global shortcut from the stored setting, remembers whether that
// worked (Settings shows it as a notice, a taken shortcut never crashes the app) and applies what the quick-ask window reports.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { getSetting } from "./api";
import { currentPlatform } from "./platform";
import { acceleratorOf, normalizeQuickAsk, QUICK_ASK_SETTING, type QuickAskSettings } from "./quickAsk";
import { quickAskApi } from "./quickAskApi";
import type { AppState } from "../state";

export type QuickAskStatus =
  { state: "off" } | { state: "on"; accelerator: string } | { state: "error"; message: string };

let status: QuickAskStatus = { state: "off" };
const listeners = new Set<() => void>();
const publish = (next: QuickAskStatus) => {
  status = next;
  listeners.forEach((l) => l());
};

export const getQuickAskStatus = () => status;
export const subscribeQuickAskStatus = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));
export const useQuickAskStatus = () => useSyncExternalStore(subscribeQuickAskStatus, getQuickAskStatus);

/** Registers (or releases) the shortcut for these settings and records the outcome. Never throws. */
export async function applyQuickAsk(settings: QuickAskSettings): Promise<QuickAskStatus> {
  const accelerator = acceleratorOf(settings, currentPlatform());
  try {
    await quickAskApi.configure(settings.enabled, accelerator, settings.hideOnBlur);
    publish(settings.enabled ? { state: "on", accelerator } : { state: "off" });
  } catch (e) {
    publish({ state: "error", message: String((e as Error)?.message ?? e) });
  }
  return status;
}

/** Test hook. */
export const resetQuickAskStatus = () => publish({ state: "off" });

/**
 * Called once from the app shell: registers the stored shortcut after start, records usage reported by the quick-ask
 * window (token statistics, usage counter, provider health) and opens the chat it stored ("Open in Gustaf").
 */
export function useQuickAskHost(
  app: Pick<AppState, "ready" | "recordTokens" | "bumpUsage" | "recordProviderResult" | "reload" | "openChat">,
) {
  const latest = useRef(app);
  latest.current = app;
  useEffect(() => {
    if (!app.ready) return;
    let cancelled = false;
    getSetting<unknown>(QUICK_ASK_SETTING, null)
      .then((raw) => {
        const settings = normalizeQuickAsk(raw);
        // Off (the default) registers nothing and needs no round trip to Rust.
        if (!cancelled && settings.enabled) return applyQuickAsk(settings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [app.ready]);
  useEffect(() => {
    // Outside Tauri (a plain browser, some tests) there is no event bridge: the listeners are simply absent.
    const safe = (subscribe: () => Promise<() => void>) => {
      try {
        return subscribe();
      } catch {
        return Promise.resolve(() => {});
      }
    };
    const subs = [
      safe(() =>
        quickAskApi.onUsage((e) => {
          const a = latest.current;
          a.bumpUsage(e.providerId);
          a.recordTokens(e.providerId, e.model, e.usage);
          a.recordProviderResult(e.providerId, e.error);
        }),
      ),
      safe(() =>
        quickAskApi.onOpenChat((e) => {
          const a = latest.current;
          a.reload()
            .then(() => a.openChat(e.chatId, null))
            .catch(() => {});
        }),
      ),
    ];
    return () => subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  }, []);
}
