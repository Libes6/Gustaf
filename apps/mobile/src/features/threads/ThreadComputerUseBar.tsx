import { useAtomValue } from "@effect/atom-react";
import {
  computerUseErrorMessage,
  computerUseHolder,
} from "@t3tools/client-runtime/state/computerUse";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { computerUseEnvironment, useComputerUseStatus } from "../../state/computerUse";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * While an agent controls the environment's Mac, who it is and a Stop that works from anywhere,
 * such as over relay. Turning control on needs a person at the Mac, so it happens in the desktop
 * app; the environment's settings say so.
 */
export function ThreadComputerUseBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId } = props;
  const gt = useGT();
  const messages = useMessages();
  const status = useComputerUseStatus(environmentId);
  const canStop = useAtomValue(computerUseEnvironment.stop.permissionAtom(environmentId));
  const stop = useAtomCommand(computerUseEnvironment.stop, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const holder =
    status === null ? "none" : computerUseHolder(status, environmentId, props.threadId);
  if (status === null || status.owner === undefined || holder === "none") return null;

  const onStop = async () => {
    setBusy(true);
    const result = await stop({ environmentId, input: {} });
    setBusy(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        gt("Could not stop control"),
        computerUseErrorMessage(squashAtomCommandFailure(result), messages),
      );
    }
  };

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="desktopcomputer" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {holder === "this-thread"
          ? gt("This thread's agent controls the Mac.")
          : gt("The Mac is controlled by “{owner}”.", { owner: status.owner.label })}
      </Text>
      <Button
        label={gt("Stop")}
        tone="danger"
        size="compact"
        disabled={busy || !canStop}
        onPress={() => void onStop()}
      />
    </View>
  );
}
