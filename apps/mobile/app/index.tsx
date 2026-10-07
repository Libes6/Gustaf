import { useRouter } from "expo-router";
import { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatView } from "../src/components/ChatView.tsx";
import { DrawerContent, DrawerShell } from "../src/components/Drawer.tsx";
import { useT } from "../src/i18n/index.ts";
import { useStore } from "../src/state/store.ts";
import { useTheme } from "../src/theme/index.ts";

function Welcome() {
  const t = useT();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { desktops, connectTo, startDemo } = useStore();
  const big = { backgroundColor: theme.accent, borderRadius: 28, height: 56, alignItems: "center" as const, justifyContent: "center" as const };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: 24, paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24, gap: 14 }}>
      <Text style={{ color: theme.text, fontSize: 34, fontWeight: "700" }}>Gustaf</Text>
      <Text style={{ color: theme.text2, fontSize: 17, lineHeight: 25, marginBottom: 10 }}>{t("welcomeLead")}</Text>
      <View style={{ gap: 6, marginBottom: 14 }}>
        {(["welcomeStep1", "welcomeStep2", "welcomeStep3"] as const).map((k, i) => (
          <View key={k} style={{ flexDirection: "row", gap: 12 }}>
            <Text style={{ color: theme.accent, fontSize: 16, fontWeight: "700", width: 20 }}>{i + 1}</Text>
            <Text style={{ color: theme.text, fontSize: 16, lineHeight: 23, flex: 1 }}>{t(k)}</Text>
          </View>
        ))}
      </View>
      <Pressable style={big} onPress={() => router.push("/pair")}>
        <Text style={{ color: theme.onAccent, fontSize: 17, fontWeight: "700" }}>{t("pairButton")}</Text>
      </Pressable>
      {desktops.map((d) => (
        <Pressable key={d.id} style={{ ...big, backgroundColor: theme.float, borderWidth: 1, borderColor: theme.border }} onPress={() => void connectTo(d)}>
          <Text style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{t("reconnect")}: {d.name}</Text>
        </Pressable>
      ))}
      <Pressable onPress={startDemo} style={{ alignItems: "center", paddingVertical: 12 }}>
        <Text style={{ color: theme.text3, fontSize: 15 }}>{t("demoButton")}</Text>
      </Pressable>
    </ScrollView>
  );
}

export default function Main() {
  const router = useRouter();
  const mode = useStore((s) => s.mode);
  const current = useStore((s) => s.current);
  const menuOpen = useStore((s) => s.menuOpen);
  const setMenu = useStore((s) => s.setMenu);
  const onOpen = useCallback(() => setMenu(true), [setMenu]);
  const onClose = useCallback(() => setMenu(false), [setMenu]);
  if (mode === "none") return <Welcome />;
  return (
    <DrawerShell open={menuOpen} onOpen={onOpen} onClose={onClose} content={<DrawerContent onSettings={() => { setMenu(false); router.push("/settings"); }} />}>
      <ChatView key={current.chatId ?? `new-${current.projectId}`} chatId={current.chatId} projectId={current.projectId} />
    </DrawerShell>
  );
}
