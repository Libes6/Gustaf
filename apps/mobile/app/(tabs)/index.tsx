import { useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { Body, Button, Card } from "../../src/components/ui.tsx";
import { useT, type StringKey } from "../../src/i18n/index.ts";
import { useStore } from "../../src/state/store.ts";

export default function Home() {
  const t = useT();
  const router = useRouter();
  const { connection, mode, activeDesktop, desktops, startDemo, connectTo, disconnect } = useStore();

  const status: StringKey =
    connection === "connected" ? "connConnected" : connection === "connecting" ? "connConnecting" : connection === "reconnecting" ? "connReconnecting" : connection === "closed" ? "connClosed" : "connNone";
  const name = mode === "demo" ? "demo" : (activeDesktop?.name ?? "");

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Card>
        <Body dim size={13}>{t("connectionTitle")}</Body>
        <Body>{t(status, { name })}</Body>
        {mode === "demo" && <Body dim size={13}>{t("demoBanner")}</Body>}
        {mode === "demo" && <Button kind="soft" title={t("cancel")} onPress={disconnect} />}
        {mode === "real" && connection === "reconnecting" && <Body dim size={13}>{activeDesktop ? `${activeDesktop.host}:${activeDesktop.port}` : ""}</Body>}
      </Card>

      {mode === "none" && (
        <Card>
          <Body>{t("pairPrompt")}</Body>
          <Body dim size={14}>{t("pairPromptDesc")}</Body>
          <Button title={t("pairButton")} onPress={() => router.push("/pair")} />
          {desktops.map((d) => (
            <Button key={d.id} kind="soft" title={`${t("reconnect")}: ${d.name}`} onPress={() => void connectTo(d)} />
          ))}
          <Button kind="soft" title={t("demoButton")} onPress={startDemo} />
        </Card>
      )}

      {mode !== "none" && <Button title={t("tabProjects")} onPress={() => router.push("/projects")} />}
    </ScrollView>
  );
}
