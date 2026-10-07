import type { ChatMessage, ToolActivity } from "@gustaf/protocol";
import { useEffect, useReducer, useRef, useState } from "react";
import { Animated, FlatList, KeyboardAvoidingView, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../i18n/index.ts";
import { initialChatState, reduceEvent, type ChatState } from "../lib/streaming.ts";
import { useStore } from "../state/store.ts";
import { mono, useTheme } from "../theme/index.ts";
import { Composer } from "./Composer.tsx";
import { Markdown } from "./Markdown.tsx";

type Action = { type: "reset"; state: ChatState } | { type: "event"; event: Parameters<typeof reduceEvent>[1] };
const reducer = (s: ChatState, a: Action): ChatState => (a.type === "reset" ? a.state : reduceEvent(s, a.event));

function Dots() {
  const theme = useTheme();
  const v = useRef(new Animated.Value(0.25)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([Animated.timing(v, { toValue: 1, duration: 600, useNativeDriver: true }), Animated.timing(v, { toValue: 0.25, duration: 600, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.Text style={{ color: theme.text2, fontSize: 22, letterSpacing: 4, opacity: v }}>●●●</Animated.Text>;
}

function ToolChip({ tool }: { tool: ToolActivity }) {
  const theme = useTheme();
  const mark = tool.status === "done" ? "✓" : tool.status === "running" ? "…" : "✕";
  const color = tool.status === "done" ? theme.green : tool.status === "running" ? theme.accent : theme.red;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.code, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, alignSelf: "flex-start", maxWidth: "100%" }}>
      <Text style={{ color, fontSize: 14, fontWeight: "700" }}>{mark}</Text>
      <Text numberOfLines={1} style={{ color: theme.text2, fontSize: 13.5, fontFamily: mono, flexShrink: 1 }}>{tool.tool} {tool.summary}</Text>
    </View>
  );
}

function Bubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const theme = useTheme();
  if (message.role === "user") {
    return (
      <View style={{ alignSelf: "flex-end", maxWidth: "84%", backgroundColor: theme.bubble, borderRadius: 24, borderBottomRightRadius: 8, paddingHorizontal: 18, paddingVertical: 12 }}>
        <Text selectable style={{ color: theme.bubbleFg, fontSize: 16.5, lineHeight: 24 }}>{message.text}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: 10 }}>
      {message.tools.length > 0 && <View style={{ gap: 6 }}>{message.tools.map((tool) => <ToolChip key={tool.id} tool={tool} />)}</View>}
      {!!message.text && <Markdown text={message.text} />}
      {streaming && !message.text && <Dots />}
    </View>
  );
}

/** One chat (or, with `chatId` null, a new chat in `projectId`): messages as they are stored on the desktop, and the floating composer. */
export function ChatView({ chatId, projectId }: { chatId: number | null; projectId: number | null }) {
  const t = useT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { api, index, openChat, setMenu, connection } = useStore();
  const [state, dispatch] = useReducer(reducer, initialChatState(chatId ?? -1));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(chatId === null);
  const list = useRef<FlatList<ChatMessage>>(null);

  const chat = chatId === null ? null : index?.chats.find((c) => c.id === chatId) ?? null;
  const project = index?.projects.find((p) => p.id === (chat?.projectId ?? projectId)) ?? null;

  useEffect(() => {
    if (!api || chatId === null) return;
    let alive = true;
    // Subscribe first so no event between the fetch and the first render is lost.
    const off = api.subscribe((event) => alive && dispatch({ type: "event", event }));
    api.listMessages(chatId).then(
      (messages) => {
        if (!alive) return;
        const known = index?.chats.find((c) => c.id === chatId);
        dispatch({ type: "reset", state: initialChatState(chatId, messages, !!known?.running) });
        setLoaded(true);
      },
      (e: unknown) => alive && (setError(e instanceof Error ? e.message : String(e)), setLoaded(true)),
    );
    return () => {
      alive = false;
      off();
    };
    // `index` is read once for the initial running flag; later changes arrive as events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, chatId]);

  // Whatever the desktop stored is the truth: a stored user message replaces the "sending" bubble.
  useEffect(() => {
    if (pending !== null && state.messages.some((m) => m.role === "user" && m.text.trim() === pending.trim())) setPending(null);
  }, [state.messages, pending]);

  const send = async (text: string) => {
    if (!api) return;
    setError(null);
    setPending(text);
    try {
      if (chatId === null) {
        if (projectId === null) throw new Error(t("noProjects"));
        const r = await api.createChat(projectId, text);
        openChat(r.chatId, projectId);
      } else {
        await api.sendMessage(chatId, { text });
      }
    } catch (e) {
      setPending(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const stop = () => {
    if (api && chatId !== null) void api.stop(chatId).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  const title = chat?.title ?? (chatId === null ? t("newChat") : "");
  const waiting = state.status === "waiting";
  const offline = connection !== "connected";
  const data = pending !== null ? [...state.messages, { id: -1, chatId: chatId ?? -1, role: "user" as const, text: pending, tools: [], createdAt: Date.now() }] : state.messages;
  const last = state.messages[state.messages.length - 1];
  const thinking = (state.running || pending !== null) && (last?.role === "user" || pending !== null || (last?.role === "assistant" && !last.text && last.tools.length === 0));

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: theme.bg }} behavior="padding">
      <FlatList<ChatMessage>
        ref={list}
        data={data}
        keyExtractor={(m) => String(m.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ paddingTop: insets.top + 74, paddingHorizontal: 18, paddingBottom: 14, gap: 22, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          loaded ? (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 10, paddingBottom: 80 }}>
              <Text style={{ color: theme.text, fontSize: 24, fontWeight: "700", textAlign: "center" }}>{chatId === null ? t("newChatTitle") : t("emptyChat")}</Text>
              {chatId === null && !!project && <Text style={{ color: theme.text2, fontSize: 15, textAlign: "center" }}>{t("newChatIn", { project: project.name })}</Text>}
            </View>
          ) : null
        }
        renderItem={({ item }) => <Bubble message={item} streaming={item.id === state.streamingMessageId && state.running} />}
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            {thinking && <View style={{ paddingVertical: 4 }}><Dots /></View>}
            {waiting && (
              <View style={{ backgroundColor: theme.code, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: theme.warn }}>
                <Text style={{ color: theme.warn, fontSize: 15, fontWeight: "700" }}>{t("waitingApproval")}</Text>
                <Text style={{ color: theme.text2, fontSize: 14, marginTop: 4 }}>{t("waitingApprovalDesc")}</Text>
              </View>
            )}
            {state.error && <Text style={{ color: theme.red, fontSize: 15 }}>{t("runFailed", { error: state.error })}</Text>}
          </View>
        }
      />

      {/* Floating top bar: menu button, title, connection dot. */}
      <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, paddingTop: insets.top + 8, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable accessibilityLabel="Menu" onPress={() => setMenu(true)} style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.float, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border }}>
          <Text style={{ color: theme.text, fontSize: 24, marginTop: -2 }}>☰</Text>
        </Pressable>
        <View pointerEvents="none" style={{ flex: 1, backgroundColor: title ? theme.float : "transparent", borderRadius: 24, height: 48, paddingHorizontal: 16, justifyContent: "center", borderWidth: title ? 1 : 0, borderColor: theme.border }}>
          {!!title && <Text numberOfLines={1} style={{ color: theme.text, fontSize: 16, fontWeight: "600" }}>{title}</Text>}
        </View>
        <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: theme.float, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: theme.border }}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: offline ? theme.warn : theme.green }} />
        </View>
      </View>

      {(error || offline) && (
        <Pressable onPress={() => setError(null)} style={{ marginHorizontal: 16, marginBottom: 4, backgroundColor: theme.code, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Text style={{ color: error ? theme.red : theme.warn, fontSize: 14 }}>{error ?? t("connReconnecting")}</Text>
        </Pressable>
      )}
      <Composer running={state.running} disabled={offline || !api} placeholder={t("messageHint")} onSend={(text) => void send(text)} onStop={stop} />
    </KeyboardAvoidingView>
  );
}
