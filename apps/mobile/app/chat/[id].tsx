import type { ChatMessage } from "@gustaf/protocol";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useReducer, useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Text, TextInput, View } from "react-native";
import { Body, Button, Card } from "../../src/components/ui.tsx";
import { useT } from "../../src/i18n/index.ts";
import { initialChatState, reduceEvent, type ChatState } from "../../src/lib/streaming.ts";
import { useStore } from "../../src/state/store.ts";
import { radius, useTheme } from "../../src/theme/index.ts";

type Action = { type: "reset"; state: ChatState } | { type: "event"; event: Parameters<typeof reduceEvent>[1] };
const reducer = (s: ChatState, a: Action): ChatState => (a.type === "reset" ? a.state : reduceEvent(s, a.event));

export default function Chat() {
  const t = useT();
  const theme = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const chatId = Number(id);
  const api = useStore((s) => s.api);
  const [state, dispatch] = useReducer(reducer, initialChatState(chatId));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = useRef<FlatList>(null);

  useEffect(() => {
    if (!api) return;
    let alive = true;
    // Subscribe first so no event between the fetch and the first render is lost.
    const off = api.subscribe((event) => alive && dispatch({ type: "event", event }));
    api.listMessages(chatId).then(
      (messages) => alive && dispatch({ type: "reset", state: initialChatState(chatId, messages) }),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
      off();
    };
  }, [api, chatId]);

  const send = async () => {
    const text = draft.trim();
    if (!api || !text) return;
    setDraft("");
    try {
      await api.sendMessage(chatId, { text });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const streaming = state.running;
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: `#${chatId}` }} />
      <FlatList<ChatMessage>
        ref={list}
        data={state.messages}
        keyExtractor={(m) => String(m.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        ListEmptyComponent={<Body dim>{t("emptyChat")}</Body>}
        renderItem={({ item }: { item: ChatMessage }) => {
          const mine = item.role === "user";
          return (
            <View style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%", gap: 6 }}>
              {item.tools.map((tool) => (
                <Card key={tool.id} style={{ padding: 8 }}>
                  <Text style={{ color: theme.text2, fontSize: 12 }}>
                    {tool.tool} · {tool.status}
                  </Text>
                  <Text style={{ color: theme.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12 }}>{tool.summary}</Text>
                </Card>
              ))}
              {(item.text || item.id === state.streamingMessageId) && (
                <View style={{ backgroundColor: mine ? theme.bubble : theme.bgElev, borderRadius: radius, padding: 10 }}>
                  {/* Markdown rendering is future work: plain text for now. */}
                  <Text style={{ color: mine ? theme.bubbleFg : theme.text, fontSize: 15, lineHeight: 21 }}>
                    {item.text}
                    {item.id === state.streamingMessageId ? " ▍" : ""}
                  </Text>
                </View>
              )}
            </View>
          );
        }}
        ListFooterComponent={
          <View style={{ gap: 8, marginTop: 8 }}>
            {state.approvals.map((a) => (
              <Card key={a.approvalId} style={{ borderColor: theme.warn }}>
                <Body>{t("approveTitle")}</Body>
                <Text style={{ color: theme.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 13 }}>
                  {a.tool}: {a.summary}
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button style={{ flex: 1 }} title={t("allow")} onPress={() => void api?.resolveApproval(a.approvalId, "allow")} />
                  <Button style={{ flex: 1 }} kind="soft" title={t("deny")} onPress={() => void api?.resolveApproval(a.approvalId, "deny")} />
                </View>
              </Card>
            ))}
            {state.error && <Body>{t("runFailed", { error: state.error })}</Body>}
            {error && <Body>{error}</Body>}
          </View>
        }
      />
      <View style={{ flexDirection: "row", gap: 8, padding: 12, borderTopColor: theme.border, borderTopWidth: 1, alignItems: "flex-end" }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t("messageHint")}
          placeholderTextColor={theme.text3}
          multiline
          style={{ flex: 1, backgroundColor: theme.bgInput, color: theme.text, borderRadius: radius, paddingHorizontal: 12, paddingVertical: 10, maxHeight: 120 }}
        />
        {streaming ? (
          <Button kind="soft" title={t("stop")} onPress={() => void api?.stop(chatId)} />
        ) : (
          <Button title={t("send")} disabled={!draft.trim()} onPress={() => void send()} />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
