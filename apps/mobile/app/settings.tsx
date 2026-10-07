import Constants from "expo-constants";
import { Alert, ScrollView, View } from "react-native";
import { Body, Button, Card } from "../src/components/ui.tsx";
import { useT } from "../src/i18n/index.ts";
import type { Locale, ThemeMode } from "../src/storage/secure.ts";
import { useStore } from "../src/state/store.ts";

export default function Settings() {
  const t = useT();
  const { prefs, setPrefs, desktops, forget, activeDesktop, connectTo } = useStore();

  const confirmForget = (id: string) =>
    Alert.alert(t("forgetTitle"), t("forgetDesc"), [
      { text: t("cancel"), style: "cancel" },
      { text: t("forget"), style: "destructive", onPress: () => void forget(id) },
    ]);

  const themes: [ThemeMode, "themeSystem" | "themeLight" | "themeDark"][] = [["system", "themeSystem"], ["light", "themeLight"], ["dark", "themeDark"]];
  const langs: [Locale | "system", "langSystem" | "language"][] = [["system", "langSystem"], ["en", "language"], ["ru", "language"]];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card>
        <Body dim size={13}>{t("pairedDesktops")}</Body>
        {desktops.length === 0 && <Body dim>{t("noDesktops")}</Body>}
        {desktops.map((d) => (
          <View key={d.id} style={{ gap: 6 }}>
            <Body>{d.name} · {d.host}:{d.port}</Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {activeDesktop?.id !== d.id && <Button style={{ flex: 1 }} kind="soft" title={t("connect")} onPress={() => void connectTo(d)} />}
              <Button style={{ flex: 1 }} kind="danger" title={t("forget")} onPress={() => confirmForget(d.id)} />
            </View>
          </View>
        ))}
      </Card>

      <Card>
        <Body dim size={13}>{t("appearance")}</Body>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {themes.map(([mode, label]) => (
            <Button key={mode} style={{ flex: 1 }} kind={prefs.theme === mode ? "primary" : "soft"} title={t(label)} onPress={() => setPrefs({ theme: mode })} />
          ))}
        </View>
      </Card>

      <Card>
        <Body dim size={13}>{t("language")}</Body>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {langs.map(([loc, label]) => (
            <Button key={loc} style={{ flex: 1 }} kind={prefs.locale === loc ? "primary" : "soft"} title={loc === "system" ? t(label) : loc.toUpperCase()} onPress={() => setPrefs({ locale: loc })} />
          ))}
        </View>
      </Card>

      <Body dim size={12}>{t("about")}: {t("appName")} {Constants.expoConfig?.version ?? ""}</Body>
    </ScrollView>
  );
}
