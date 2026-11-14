import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { t } from "../../i18n";
import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { computerUseEnvironment, useComputerUseStatus } from "../../state/computerUse";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * While an agent controls the environment's Mac, who it is and a Stop that works from anywhere,
 * such as over relay. Turning control on happens in the desktop or web app.
 */
export function ThreadComputerUseBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId } = props;
  const status = useComputerUseStatus(environmentId);
  const canStop = useAtomValue(computerUseEnvironment.stop.permissionAtom(environmentId));
  const stop = useAtomCommand(computerUseEnvironment.stop, "stop computer use");
  const [busy, setBusy] = useState(false);
  const owner = status?.owner;
  if (owner === undefined) return null;
  const here = owner.environmentId === environmentId && owner.threadId === props.threadId;

  const onStop = async () => {
    setBusy(true);
    const result = await stop({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(t("Could not stop control"), error instanceof Error ? error.message : "");
    }
  };

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="desktopcomputer" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {here
          ? t("This thread's agent controls the Mac")
          : `${t("The Mac is controlled by")} ${owner.label}`}
      </Text>
      <Button
        label={t("Stop")}
        tone="danger"
        disabled={busy || !canStop}
        onPress={() => void onStop()}
      />
    </View>
  );
}
