import { Linking, Platform, ScrollView, Text, View } from "react-native";
import { parseMarkdown, type Block, type Inline } from "../lib/markdown.ts";
import { mono, useTheme, type Tokens } from "../theme/index.ts";

/** Renders an assistant message (lib/markdown.ts). Text is selectable; code blocks scroll sideways and keep their formatting. */
export function Markdown({ text }: { text: string }) {
  const t = useTheme();
  const blocks = parseMarkdown(text);
  return <View style={{ gap: 12 }}>{blocks.map((b, i) => <BlockView key={i} block={b} t={t} />)}</View>;
}

const body = (t: Tokens) => ({ color: t.text, fontSize: 16.5, lineHeight: 25 });

function Spans({ inline, t, base }: { inline: Inline[]; t: Tokens; base?: object }) {
  return (
    <>
      {inline.map((n, i) => {
        switch (n.type) {
          case "text":
            return <Text key={i}>{n.text}</Text>;
          case "bold":
            return <Text key={i} style={{ fontWeight: "700" }}><Spans inline={n.children} t={t} /></Text>;
          case "italic":
            return <Text key={i} style={{ fontStyle: "italic" }}><Spans inline={n.children} t={t} /></Text>;
          case "code":
            return <Text key={i} style={{ fontFamily: mono, fontSize: 14.5, backgroundColor: t.code, color: t.text }}>{` ${n.text} `}</Text>;
          case "link":
            return <Text key={i} style={{ color: t.accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(n.url)}>{n.text}</Text>;
        }
      })}
    </>
  );
}

function BlockView({ block, t }: { block: Block; t: Tokens }) {
  switch (block.type) {
    case "paragraph":
      return <Text selectable style={body(t)}><Spans inline={block.inline} t={t} /></Text>;
    case "heading":
      return <Text selectable style={{ ...body(t), fontSize: block.level === 1 ? 22 : block.level === 2 ? 19 : 17, lineHeight: 28, fontWeight: "700", marginTop: 4 }}><Spans inline={block.inline} t={t} /></Text>;
    case "quote":
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: t.border, paddingLeft: 12 }}>
          <Text selectable style={{ ...body(t), color: t.text2 }}><Spans inline={block.inline} t={t} /></Text>
        </View>
      );
    case "list":
      return (
        <View style={{ gap: 6 }}>
          {block.items.map((it, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 10, paddingRight: 8 }}>
              <Text style={{ ...body(t), width: 22, textAlign: "right", color: t.text2 }}>{block.ordered ? `${it.number}.` : "•"}</Text>
              <Text selectable style={{ ...body(t), flex: 1 }}><Spans inline={it.inline} t={t} /></Text>
            </View>
          ))}
        </View>
      );
    case "code":
      return (
        <View style={{ backgroundColor: t.code, borderRadius: 18, paddingVertical: 12 }}>
          {!!block.lang && <Text style={{ color: t.text3, fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 }}>{block.lang}</Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16 }}>
            <Text selectable style={{ color: t.text, fontFamily: mono, fontSize: 13.5, lineHeight: 20, ...(Platform.OS === "android" ? { includeFontPadding: false } : {}) }}>{block.text}</Text>
          </ScrollView>
        </View>
      );
  }
}
