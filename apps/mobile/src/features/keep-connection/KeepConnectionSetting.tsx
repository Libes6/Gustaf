import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import * as Notifications from "expo-notifications";
import { msg, useGT } from "gt-react-native";
import { useState } from "react";
import { Linking, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { m } from "../../i18n/messages";
import { makePermissionStatusAtom } from "../../lib/permissionStatusAtom";
import { mobilePreferencesAtom, saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { keepConnectionState } from "./keepConnection.logic";
import { supportsKeepConnection } from "./keepConnectionNative";

const notificationsAllowedAtom = makePermissionStatusAtom<boolean | null>({
  label: "mobile:keep-connection:notification-permission",
  initial: null,
  read: () =>
    Notifications.getPermissionsAsync().then(
      (permission) => permission.granted,
      () => false,
    ),
});

async function requestNotifications(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted || !existing.canAskAgain) return existing.granted;
    return (await Notifications.requestPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

function alertNotificationsNeeded() {
  Dialog.alert(
    m(msg("Notification permission needed")),
    m(
      msg(
        "Android shows a notification while Gustaf keeps the connection. Allow notifications in system Settings to turn this on.",
      ),
    ),
    [
      { text: m(msg("Cancel")), style: "cancel" },
      { text: m(msg("Open Settings")), onPress: () => void Linking.openSettings() },
    ],
  );
}

/** Android only: iOS suspends the app's sockets in the background whatever it asks for. */
export function KeepConnectionSetting() {
  return supportsKeepConnection() ? <KeepConnectionRows /> : null;
}

function KeepConnectionRows() {
  const gt = useGT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomCommand(saveMobilePreferences);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const notificationsAllowed = useAtomValue(notificationsAllowedAtom);
  const setNotificationsAllowed = useAtomSet(notificationsAllowedAtom);
  const [saving, setSaving] = useState(false);
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const enabled =
    AsyncResult.isSuccess(preferences) && preferences.value.keepConnectionInBackground === true;
  const state = keepConnectionState({
    supported: true,
    enabled,
    notificationsAllowed: notificationsAllowed !== false,
    environmentCount: [...catalog.entries.values()].filter((entry) => entry.enabled).length,
  });

  const change = async (value: boolean) => {
    setSaving(true);
    if (value) {
      const granted = await requestNotifications();
      setNotificationsAllowed(granted);
      if (!granted) {
        setSaving(false);
        alertNotificationsNeeded();
        return;
      }
    }
    const result = await savePreferences({ keepConnectionInBackground: value });
    if (result._tag === "Failure") {
      console.warn("[keep-connection] could not save the setting", result.cause);
    }
    setSaving(false);
  };

  return (
    <View className="mt-5 gap-3">
      <SettingsSection title={gt("Background connection")}>
        <SettingsSwitchRow
          icon="bolt.horizontal.circle"
          label={gt("Keep connection in background")}
          disabled={!ready || saving}
          value={enabled}
          onValueChange={(value) => void change(value)}
        />
        {state === "needs-permission" ? (
          <SettingsRow
            icon="bell.badge"
            label={gt("Allow notifications")}
            value={gt("Notifications are off, so the connection is not kept.")}
            onPress={() => void Linking.openSettings()}
          />
        ) : null}
      </SettingsSection>
      <Text className="px-2 text-sm leading-normal text-foreground-muted">
        {state === "idle"
          ? gt("Starts once an environment is enabled.")
          : gt(
              "Gustaf keeps running with a permanent notification, so returning to the app does not wait for a reconnect. Uses more battery.",
            )}
      </Text>
    </View>
  );
}
