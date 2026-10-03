import type { ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { radius, useTheme } from "../theme/index.ts";

export function Button(props: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "soft" | "danger";
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const kind = props.kind ?? "primary";
  const bg = kind === "primary" ? t.accent : kind === "danger" ? t.red : t.bgElev;
  const fg = kind === "soft" ? t.text : t.onAccent;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={[{ backgroundColor: bg, borderRadius: radius, paddingVertical: 12, paddingHorizontal: 16, opacity: props.disabled ? 0.5 : 1, alignItems: "center" }, props.style]}
    >
      <Text style={{ color: fg, fontWeight: "600", fontSize: 15 }}>{props.title}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return (
    <View style={[{ backgroundColor: t.bgElev, borderRadius: radius, borderColor: t.border, borderWidth: 1, padding: 14, gap: 8 }, style]}>
      {children}
    </View>
  );
}

export function Body({ children, dim, size }: { children: ReactNode; dim?: boolean; size?: number }) {
  const t = useTheme();
  return <Text style={{ color: dim ? t.text2 : t.text, fontSize: size ?? 15, lineHeight: (size ?? 15) * 1.4 }}>{children}</Text>;
}
