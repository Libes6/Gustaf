import type { ChatSummary, ProjectSummary } from "@gustaf/protocol";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, Dimensions, Easing, PanResponder, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../i18n/index.ts";
import { useStore } from "../state/store.ts";
import { useTheme } from "../theme/index.ts";

const WIDTH = Math.min(Dimensions.get("window").width * 0.84, 340);

/** Side menu: opens from a swipe at the left edge or the menu button, closes on a scrim tap or a swipe back. */
export function DrawerShell({ open, onOpen, onClose, children, content }: { open: boolean; onOpen: () => void; onClose: () => void; children: ReactNode; content: ReactNode }) {
  const theme = useTheme();
  const x = useRef(new Animated.Value(open ? 0 : -WIDTH)).current;
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    Animated.timing(x, { toValue: open ? 0 : -WIDTH, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [open, x]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
        onPanResponderMove: (_, g) => x.setValue(Math.max(-WIDTH, Math.min(0, (openRef.current ? 0 : -WIDTH) + g.dx))),
        onPanResponderRelease: (_, g) => {
          const shown = (openRef.current ? 0 : -WIDTH) + g.dx;
          const wantOpen = g.vx > 0.4 ? true : g.vx < -0.4 ? false : shown > -WIDTH / 2;
          if (wantOpen === openRef.current) Animated.timing(x, { toValue: wantOpen ? 0 : -WIDTH, duration: 160, useNativeDriver: true }).start();
          else (wantOpen ? onOpen : onClose)();
        },
      }),
    [x, onOpen, onClose],
  );

  const scrim = x.interpolate({ inputRange: [-WIDTH, 0], outputRange: [0, 1] });
  return (
    <View style={{ flex: 1 }} {...pan.panHandlers}>
      {children}
      <Animated.View pointerEvents={open ? "auto" : "none"} style={{ position: "absolute", inset: 0, backgroundColor: theme.scrim, opacity: scrim }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close menu" />
      </Animated.View>
      <Animated.View style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: WIDTH, backgroundColor: theme.drawer, transform: [{ translateX: x }] }}>{content}</Animated.View>
    </View>
  );
}

const dotColor = (c: ChatSummary, t: ReturnType<typeof useTheme>) =>
  c.status === "waiting" ? t.warn : c.status === "failed" ? t.red : c.running || c.status === "running" ? t.accent : c.status === "done" ? t.green : null;

function ChatRow({ chat, active, onPress }: { chat: ChatSummary; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  const dot = dotColor(chat, theme);
  return (
    <Pressable onPress={onPress} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 13, paddingHorizontal: 20, backgroundColor: active ? theme.float : "transparent" }}>
      <Text numberOfLines={1} style={{ flex: 1, color: theme.text, fontSize: 16.5 }}>{chat.title || "…"}</Text>
      {dot && <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: dot }} />}
    </Pressable>
  );
}

/** The menu's content: connection, projects with their chats, the "Chat" button and settings. */
export function DrawerContent({ onSettings }: { onSettings: () => void }) {
  const t = useT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { index, indexError, current, openChat, newChat, connection, mode, activeDesktop, refreshIndex } = useStore();
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const byProject = useMemo(() => {
    const map = new Map<number, ChatSummary[]>();
    for (const c of [...(index?.chats ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)) map.set(c.projectId, [...(map.get(c.projectId) ?? []), c]);
    return map;
  }, [index]);
  const state = connection === "connected" ? theme.green : connection === "none" || connection === "closed" ? theme.text3 : theme.warn;
  const name = mode === "demo" ? "demo" : (activeDesktop?.name ?? "");

  const projectHeader = (p: ProjectSummary) => (
    <View key={`h${p.id}`} style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 18, paddingBottom: 6 }}>
      <Pressable style={{ flex: 1 }} onPress={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
        <Text style={{ color: theme.text2, fontSize: 13.5, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}>
          {collapsed[p.id] ? "▸ " : "▾ "}{p.pinned ? "★ " : ""}{p.name}
        </Text>
      </Pressable>
      <Pressable accessibilityLabel={t("newChat")} hitSlop={10} onPress={() => newChat(p.id)}>
        <Text style={{ color: theme.accent, fontSize: 22, lineHeight: 24 }}>＋</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 14 }}>
      <View style={{ paddingHorizontal: 20, paddingBottom: 6 }}>
        <Text style={{ color: theme.text, fontSize: 27, fontWeight: "700" }}>Gustaf</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: state }} />
          <Text numberOfLines={1} style={{ color: theme.text2, fontSize: 14 }}>
            {connection === "connected" ? name || t("connConnected", { name: "" }).trim() : connection === "none" ? t("connNone") : connection === "reconnecting" ? t("connReconnecting") : t("connConnecting")}
          </Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 130 }}>
        {!index && !indexError && <Text style={{ color: theme.text3, padding: 20 }}>{t("loading")}</Text>}
        {indexError && (
          <Pressable onPress={() => void refreshIndex()} style={{ padding: 20 }}>
            <Text style={{ color: theme.red }}>{indexError}</Text>
            <Text style={{ color: theme.accent, marginTop: 6 }}>{t("retry")}</Text>
          </Pressable>
        )}
        {index && index.projects.length === 0 && <Text style={{ color: theme.text3, padding: 20 }}>{t("noProjects")}</Text>}
        {index?.projects.map((p) => (
          <View key={p.id}>
            {projectHeader(p)}
            {!collapsed[p.id] && (byProject.get(p.id) ?? []).map((c) => <ChatRow key={c.id} chat={c} active={current.chatId === c.id} onPress={() => openChat(c.id, p.id)} />)}
            {!collapsed[p.id] && !(byProject.get(p.id)?.length) && <Text style={{ color: theme.text3, paddingHorizontal: 20, paddingVertical: 8 }}>{t("noChats")}</Text>}
          </View>
        ))}
      </ScrollView>
      <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingBottom: Math.max(insets.bottom, 14) + 4, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Pressable onPress={() => newChat()} style={{ backgroundColor: theme.accent, borderRadius: 28, paddingHorizontal: 22, height: 54, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Text style={{ color: theme.onAccent, fontSize: 20 }}>✎</Text>
          <Text style={{ color: theme.onAccent, fontSize: 18, fontWeight: "700" }}>{t("newChatCta")}</Text>
        </Pressable>
        <Pressable accessibilityLabel={t("settings")} onPress={onSettings} style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: theme.float, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border }}>
          <Text style={{ color: theme.text, fontSize: 24 }}>⚙</Text>
        </Pressable>
      </View>
    </View>
  );
}
