import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/reactivity";
import { AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { t } from "../../i18n";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { keepConnectionState } from "./keepConnection.logic";
import {
  keepConnectionRunningSince,
  onKeepConnectionTurnedOff,
  startKeepConnection,
  stopKeepConnection,
  supportsKeepConnection,
  takeKeepConnectionTurnedOff,
} from "./keepConnectionNative";

/**
 * Runs the Android keep-connection service while the option is on, notifications are allowed and
 * an environment is enabled. Starts only while the app is active, since Android refuses a
 * foreground service started from the background; a service the OS killed starts again on open.
 */
export function installKeepConnection(): () => void {
  if (!supportsKeepConnection()) return () => undefined;
  let latest = 0;
  let inputs: string | null = null;
  let shownTitle: string | null = null;

  const release = () => {
    if (shownTitle === null && keepConnectionRunningSince() === null) return;
    shownTitle = null;
    stopKeepConnection();
  };

  const reconcile = (recheck: boolean) => {
    if (takeKeepConnectionTurnedOff()) {
      appAtomRegistry.set(updateMobilePreferencesAtom, { keepConnectionInBackground: false });
      release();
      return;
    }
    const preferences = appAtomRegistry.get(mobilePreferencesAtom);
    const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
    if (!AsyncResult.isSuccess(preferences) || !catalog.isReady) return;
    const enabled = preferences.value.keepConnectionInBackground === true;
    const labels = [...catalog.entries.values()]
      .filter((entry) => entry.enabled)
      .map((entry) => entry.target.label);
    // Preferences change often for unrelated keys; only these inputs matter here.
    const next = `${enabled}\n${labels.join("\n")}`;
    if (!recheck && next === inputs) return;
    inputs = next;
    // Also drops a permission read still pending from an earlier pass.
    const run = ++latest;
    if (!enabled || labels.length === 0) {
      release();
      return;
    }
    void Notifications.getPermissionsAsync()
      .then(
        (permission) => permission.granted,
        () => false,
      )
      .then((notificationsAllowed) => {
        if (run !== latest) return;
        const state = keepConnectionState({
          supported: true,
          enabled,
          notificationsAllowed,
          environmentCount: labels.length,
        });
        if (state !== "on") {
          release();
          return;
        }
        if (AppState.currentState !== "active") return;
        const title = t("Connection to {names} is active").replace("{names}", labels.join(", "));
        if (title === shownTitle && keepConnectionRunningSince() !== null) return;
        const started = startKeepConnection({
          title,
          text: t("Gustaf stays connected in the background. Tap to open."),
          stopLabel: t("Turn off"),
          channelName: t("Background connection"),
        });
        shownTitle = started ? title : null;
      });
  };

  const unsubscribePreferences = appAtomRegistry.subscribe(mobilePreferencesAtom, () =>
    reconcile(false),
  );
  const unsubscribeCatalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    () => reconcile(false),
    { immediate: true },
  );
  // Notification access can change in system Settings, and the OS may have stopped the service.
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") reconcile(true);
  });
  const unsubscribeTurnedOff = onKeepConnectionTurnedOff(() => reconcile(true));
  return () => {
    unsubscribePreferences();
    unsubscribeCatalog();
    appState.remove();
    unsubscribeTurnedOff();
  };
}
