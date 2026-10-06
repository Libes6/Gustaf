import type { PairingQrPayload } from "@gustaf/protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Linking, ScrollView, TextInput, View } from "react-native";
import { Body, Button, Card } from "../src/components/ui.tsx";
import { useT } from "../src/i18n/index.ts";
import { parsePairingPayload, shortFingerprint, type PairingErrorCode } from "../src/lib/pairing.ts";
import { useStore } from "../src/state/store.ts";
import { radius, useTheme } from "../src/theme/index.ts";

export default function Pair() {
  const t = useT();
  const theme = useTheme();
  const router = useRouter();
  const pair = useStore((s) => s.pair);
  const [permission, requestPermission] = useCameraPermissions();
  const [payload, setPayload] = useState<PairingQrPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");
  const lastScan = useRef("");

  const accept = (text: string) => {
    const r = parsePairingPayload(text);
    if (r.ok) {
      setPayload(r.payload);
      setError(null);
    } else {
      setPayload(null);
      setError(t(`pairError.${r.error}` as `pairError.${PairingErrorCode}`, { field: r.field ?? "" }));
    }
  };

  const onScan = (data: string) => {
    if (payload || busy || data === lastScan.current) return; // the scanner fires repeatedly for the same code
    lastScan.current = data;
    accept(data);
  };

  const confirm = async () => {
    if (!payload) return;
    setBusy(true);
    try {
      await pair(payload, "My phone");
      router.back();
    } catch (e) {
      setError(t("pairFailed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
      {payload ? (
        <Card>
          <Body>{t("pairConfirm", { host: payload.host, port: payload.port })}</Body>
          <Body dim size={13}>{t("pairFingerprint")}: {shortFingerprint(payload.fingerprint)}</Body>
          <Body dim size={13}>{t("pairWarnUnpinned")}</Body>
          <Button title={busy ? t("pairing") : t("connect")} disabled={busy} onPress={() => void confirm()} />
          <Button kind="soft" title={t("scanAgain")} onPress={() => { setPayload(null); lastScan.current = ""; }} />
        </Card>
      ) : !permission ? (
        <Body dim>{t("loading")}</Body>
      ) : permission.granted ? (
        <View style={{ height: 320, borderRadius: radius, overflow: "hidden" }}>
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => onScan(data)}
          />
        </View>
      ) : (
        <Card>
          <Body>{permission.canAskAgain ? t("cameraPermission") : t("cameraDenied")}</Body>
          {permission.canAskAgain ? (
            <Button title={t("grantCamera")} onPress={() => void requestPermission()} />
          ) : (
            <Button title={t("openSettings")} onPress={() => void Linking.openSettings()} />
          )}
        </Card>
      )}

      {error && (
        <Card style={{ borderColor: theme.red }}>
          <Body>{error}</Body>
        </Card>
      )}

      <Body dim size={13}>{t("pasteHint")}</Body>
      <TextInput
        value={manual}
        onChangeText={setManual}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        placeholder="gustaf://pair?host=…"
        placeholderTextColor={theme.text3}
        style={{ backgroundColor: theme.bgInput, color: theme.text, borderRadius: radius, padding: 12, minHeight: 64 }}
      />
      <Button kind="soft" title={t("pasteUse")} onPress={() => accept(manual)} />
    </ScrollView>
  );
}
