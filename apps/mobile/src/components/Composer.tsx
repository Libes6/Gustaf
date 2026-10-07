import { useState } from "react";
import { Platform, Pressable, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useT } from "../i18n/index.ts";
import { useTheme } from "../theme/index.ts";

/** The floating message field: a rounded pill with a round send button, which becomes Stop while the desktop works. */
export function Composer({ running, disabled, placeholder, onSend, onStop }: { running: boolean; disabled?: boolean; placeholder?: string; onSend: (text: string) => void; onStop: () => void }) {
  const t = useT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const canSend = !!draft.trim() && !disabled && !running;
  const send = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    setDraft("");
    onSend(text);
  };
  return (
    <View style={{ paddingHorizontal: 12, paddingBottom: Math.max(insets.bottom, 10), paddingTop: 6 }}>
      <View style={{ backgroundColor: theme.float, borderRadius: 30, borderWidth: 1, borderColor: theme.border, flexDirection: "row", alignItems: "flex-end", paddingLeft: 18, paddingRight: 6, paddingVertical: 6 }}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder ?? t("messageHint")}
          placeholderTextColor={theme.text3}
          multiline
          editable={!disabled}
          style={{ flex: 1, color: theme.text, fontSize: 16.5, maxHeight: 140, paddingTop: Platform.OS === "ios" ? 10 : 8, paddingBottom: Platform.OS === "ios" ? 10 : 8 }}
        />
        {running ? (
          <Pressable accessibilityRole="button" accessibilityLabel={t("stop")} onPress={onStop} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: theme.text, alignItems: "center", justifyContent: "center", marginLeft: 6 }}>
            <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: theme.bg }} />
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel={t("send")} disabled={!canSend} onPress={send} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: canSend ? theme.accent : theme.border, alignItems: "center", justifyContent: "center", marginLeft: 6 }}>
            <Text style={{ color: canSend ? theme.onAccent : theme.text3, fontSize: 22, fontWeight: "700", marginTop: -2 }}>↑</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
