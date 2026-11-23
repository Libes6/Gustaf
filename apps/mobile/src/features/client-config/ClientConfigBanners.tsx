import { announcementText } from "@t3tools/client-runtime/client-config";
import * as Linking from "expo-linking";
import { T, useGT, useLocale } from "gt-react-native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { clientConfigStore, LATEST_RELEASE_URL, useClientConfig } from "./clientConfig";

const MAX_SHOWN = 2;

const openUrl = (url: string) => void Linking.openURL(url).catch(() => undefined);

/** Cloud announcements and the minimum-version notice, floating above every screen. */
export function ClientConfigBanners() {
  const gt = useGT();
  const locale = useLocale();
  const insets = useSafeAreaInsets();
  const { config, announcements } = useClientConfig();
  if (!config.update.required && announcements.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute inset-x-0 gap-2 px-4"
      style={{ top: insets.top + 8 }}
    >
      {config.update.required ? (
        <View className="gap-3 rounded-2xl border border-border bg-card p-4">
          <AppText textRole="headline" className="text-foreground">
            <T>Update Gustaf</T>
          </AppText>
          <AppText textRole="footnote" className="text-foreground">
            {config.update.message ??
              gt(
                "This version is no longer supported. Install the latest update to keep using Gustaf.",
              )}
          </AppText>
          {config.update.minimumVersion ? (
            <AppText textRole="footnote" className="text-foreground-muted">
              {gt("Required version: {version}", { version: config.update.minimumVersion })}
            </AppText>
          ) : null}
          {Platform.OS === "android" ? (
            <Button
              label={gt("Download update")}
              icon="arrow.down.circle"
              tone="primary"
              size="compact"
              onPress={() => openUrl(LATEST_RELEASE_URL)}
            />
          ) : null}
        </View>
      ) : null}
      {announcements.slice(0, MAX_SHOWN).map((announcement) => (
        <View key={announcement.id} className="gap-2">
          <Notice
            floating
            tone={announcement.level === "critical" ? "danger" : "default"}
            icon={announcement.level === "info" ? "info.circle" : "exclamationmark.triangle"}
            message={announcementText(announcement, locale)}
            dismissLabel={gt("Dismiss")}
            onDismiss={() => clientConfigStore.dismiss(announcement.id)}
          />
          {announcement.link ? (
            <Button
              label={gt("Learn more")}
              tone="text"
              size="compact"
              onPress={() => openUrl(announcement.link!)}
            />
          ) : null}
        </View>
      ))}
    </View>
  );
}
