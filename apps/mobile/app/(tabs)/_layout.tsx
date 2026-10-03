import { Tabs } from "expo-router";
import { useT } from "../../src/i18n/index.ts";
import { useTheme } from "../../src/theme/index.ts";

export default function TabsLayout() {
  const t = useT();
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.text,
        tabBarStyle: { backgroundColor: theme.bg, borderTopColor: theme.border },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.text3,
        tabBarIconStyle: { display: "none" },
        tabBarLabelStyle: { fontSize: 14, marginBottom: 12 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: t("tabHome") }} />
      <Tabs.Screen name="projects" options={{ title: t("tabProjects") }} />
      <Tabs.Screen name="settings" options={{ title: t("tabSettings") }} />
    </Tabs>
  );
}
