import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import {
  hasDesktopNotifications,
  hasNotificationSound,
  unlockNotificationAudio,
} from "../../threadNotifications";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { useT } from "../../useUiLanguage";
import { useLocalizedSettingLookup } from "./useLocalizedSettingLookup";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function NotificationSettings() {
  const mode = useScopedSettings((settings) => settings.notificationMode);
  const updateSettings = useUpdateScopedSettings();
  const t = useT();
  const row = useLocalizedSettingLookup();
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);

  return (
    <SettingsRow
      {...row("thread-notifications")}
      description={permissionMessage ?? t("setting.thread-notifications.description")}
      control={
        <Select
          value={mode}
          disabled={requesting}
          onValueChange={async (value) => {
            if (
              value !== "off" &&
              value !== "notifications" &&
              value !== "sound" &&
              value !== "notifications-and-sound"
            )
              return;
            setPermissionMessage(null);
            if (hasNotificationSound(value)) unlockNotificationAudio();
            if (hasDesktopNotifications(value)) {
              if (typeof Notification === "undefined" || !window.isSecureContext) {
                setPermissionMessage(t("option.notifications.https"));
                return;
              }
              setRequesting(true);
              const permission = await settlePromise(() => Notification.requestPermission());
              setRequesting(false);
              if (permission._tag === "Failure") {
                setPermissionMessage(t("option.notifications.unavailable"));
                return;
              }
              if (permission.value !== "granted") {
                setPermissionMessage(t("option.notifications.denied"));
                return;
              }
            }
            updateSettings({ notificationMode: value });
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-56"
            aria-label={t("setting.thread-notifications.title")}
          >
            <SelectValue>
              {t(
                mode === "notifications"
                  ? "option.notifications.only"
                  : mode === "sound"
                    ? "option.notifications.sound"
                    : mode === "notifications-and-sound"
                      ? "option.notifications.both"
                      : "option.notifications.off",
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(
              [
                ["off", "option.notifications.off"],
                ["notifications", "option.notifications.only"],
                ["sound", "option.notifications.sound"],
                ["notifications-and-sound", "option.notifications.both"],
              ] as const
            ).map(([value, label]) => (
              <SelectItem key={value} hideIndicator value={value}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
