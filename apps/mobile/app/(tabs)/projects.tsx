import type { ChatSummary, ProjectSummary } from "@gustaf/protocol";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import { Body, Button } from "../../src/components/ui.tsx";
import { useT } from "../../src/i18n/index.ts";
import { useStore } from "../../src/state/store.ts";
import { useTheme } from "../../src/theme/index.ts";

interface Section {
  project: ProjectSummary;
  data: ChatSummary[];
}

export default function Projects() {
  const t = useT();
  const theme = useTheme();
  const router = useRouter();
  const api = useStore((s) => s.api);
  const [sections, setSections] = useState<Section[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    setError(null);
    try {
      const projects = await api.listProjects();
      const all = await Promise.all(projects.map(async (project) => ({ project, data: (await api.listChats(project.id)).filter((c) => !c.archived) })));
      setSections(all);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    void load();
    return api?.subscribe((e) => {
      if (e.type === "chat.updated") void load();
    });
  }, [api, load]);

  if (!api) return <View style={{ padding: 16 }}><Body dim>{t("connNone")}</Body></View>;
  if (error) {
    return (
      <View style={{ padding: 16, gap: 12 }}>
        <Body>{error}</Body>
        <Button title={t("retry")} onPress={() => void load()} />
      </View>
    );
  }
  if (!sections) return <View style={{ padding: 16 }}><Body dim>{t("loading")}</Body></View>;
  if (sections.length === 0) return <View style={{ padding: 16 }}><Body dim>{t("noProjects")}</Body></View>;

  return (
    <SectionList
      sections={sections}
      keyExtractor={(c) => String(c.id)}
      contentContainerStyle={{ padding: 16, gap: 4 }}
      renderSectionHeader={({ section }) => (
        <Text style={{ color: theme.text2, fontWeight: "700", marginTop: 12, marginBottom: 4 }}>
          {(section as unknown as Section).project.pinned ? "★ " : ""}
          {(section as unknown as Section).project.name}
        </Text>
      )}
      renderSectionFooter={({ section }) => (section.data.length === 0 ? <Body dim size={13}>{t("noChats")}</Body> : null)}
      renderItem={({ item }) => (
        <Pressable
          onPress={() => router.push({ pathname: "/chat/[id]", params: { id: String(item.id) } })}
          style={{ backgroundColor: theme.bgElev, borderRadius: 10, padding: 12, marginBottom: 6, flexDirection: "row", justifyContent: "space-between" }}
        >
          <Text style={{ color: theme.text, flexShrink: 1 }}>{item.title}</Text>
          {item.running && <Text style={{ color: theme.accent }}>{t("running")}</Text>}
        </Pressable>
      )}
    />
  );
}
