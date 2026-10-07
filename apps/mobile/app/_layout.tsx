import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { useT } from "../src/i18n/index.ts";
import { useStore } from "../src/state/store.ts";
import { useTheme } from "../src/theme/index.ts";

export default function RootLayout() {
  const t = useT();
  const theme = useTheme();
  const init = useStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);

  return (
    <>
      <StatusBar style={theme.scheme === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.bg },
          headerTintColor: theme.text,
          contentStyle: { backgroundColor: theme.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ title: t("pairTitle"), presentation: "modal" }} />
        <Stack.Screen name="settings" options={{ title: t("settings") }} />
      </Stack>
    </>
  );
}
