import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  type RelayComputer,
  type RelayPairingProgress,
  RELAY_PAIRING_IDLE,
  relayComputersOfEnvironments,
  startRelayComputerPairing,
} from "@t3tools/client-runtime/gustaf-relay";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { cn } from "../../lib/cn";
import { accountComputersView, canListAccountComputers } from "../relay/accountComputersState";
import { gustafRelay } from "../relay/relayPool";
import { useAccountComputers } from "../relay/useAccountComputers";
import { useAccount } from "../account/useAccount";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

/**
 * The computers on the user's Gustaf account, one tap from pairing: the computer asks its own
 * user, who compares the safety code shown here, instead of the phone scanning a QR code.
 */
export function AccountComputersSection(props: {
  readonly routeFor: EnvironmentId | undefined;
  /** Pairs the link the computer sent back; resolves to what the form shows of the outcome. */
  readonly connect: (
    pairingUrl: string,
    environmentId: EnvironmentId | undefined,
  ) => Promise<{ readonly ok: boolean; readonly error: string | null }>;
  readonly onPaired: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const account = useAccount();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { load, refresh } = useAccountComputers(canListAccountComputers(account));
  const [progress, setProgress] = useState<RelayPairingProgress>(RELAY_PAIRING_IDLE);
  const attempt = useRef<{ readonly cancel: () => void } | null>(null);
  const view = accountComputersView({
    account,
    load,
    connected: relayComputersOfEnvironments([...catalog.entries.values()]),
  });
  const busy = progress.phase === "connecting" || progress.phase === "waiting";

  const pair = (computer: RelayComputer) => {
    if (busy) return;
    const started = startRelayComputerPairing({
      relay: gustafRelay,
      computer,
      routeFor: props.routeFor,
      connect: props.connect,
      onProgress: setProgress,
      resolve: m,
    });
    attempt.current = started;
    void started.done.then((result) => {
      if (attempt.current === started) attempt.current = null;
      if (result.status === "paired") props.onPaired();
    });
  };

  const openAccount = () => navigation.navigate("SettingsAccount");

  return (
    <SettingsSection
      title={gt("My computers")}
      footer={gt(
        "Computers signed in to your Gustaf account. Tap one to connect, then allow this phone on that computer after checking the safety code.",
      )}
    >
      {view.kind === "signedOut" ? (
        <ListRow
          icon="person.crop.circle"
          label={gt("Sign in to see your computers")}
          description={gt("They are listed from your Gustaf account.")}
          onPress={openAccount}
        />
      ) : view.kind === "unregistered" ? (
        <ListRow
          icon="iphone"
          label={gt("Register this phone to see your computers")}
          description={gt("Under Settings → Account.")}
          onPress={openAccount}
        />
      ) : view.kind === "loading" ? (
        <View className="items-center p-4">
          <AppActivityIndicator />
        </View>
      ) : view.kind === "unavailable" ? (
        <ListActionRow
          icon="arrow.clockwise"
          label={gt("Could not reach the Gustaf relay")}
          description={gt("Tap to try again.")}
          onPress={refresh}
        />
      ) : view.kind === "empty" ? (
        <Text className="p-4 text-base text-foreground-muted">
          {gt(
            "No other computers on your account yet. Open Gustaf on a computer and sign in with the same account.",
          )}
        </Text>
      ) : (
        view.computers.map((computer) => (
          <ListRow
            key={computer.deviceId}
            leading={
              <ConnectionStatusDot
                state={computer.online ? "connected" : "available"}
                pulse={false}
              />
            }
            label={computer.name}
            description={computer.online ? gt("Online") : gt("Offline")}
            disabled={!computer.online || busy}
            onPress={() => pair(computer)}
          />
        ))
      )}
      {progress.phase === "idle" ? null : (
        <View accessibilityLiveRegion="polite" className="gap-3 border-t border-border-subtle p-4">
          <Text
            className={cn(
              "text-base leading-normal",
              progress.phase === "failed" ? "text-danger-foreground" : "text-foreground-muted",
            )}
          >
            {progress.phase === "connecting"
              ? gt("Connecting to {name} through the Gustaf relay…", {
                  name: progress.computer.name,
                })
              : progress.phase === "waiting"
                ? gt(
                    "Allow this phone on {name} to finish pairing. It shows the same safety code: {code}",
                    { name: progress.computer.name, code: progress.safetyCode },
                  )
                : progress.message}
          </Text>
          {progress.phase === "waiting" ? (
            <Text selectable className="font-mono text-2xl tracking-widest text-foreground">
              {progress.safetyCode}
            </Text>
          ) : null}
          {busy ? <Button label={gt("Cancel")} onPress={() => attempt.current?.cancel()} /> : null}
        </View>
      )}
    </SettingsSection>
  );
}
