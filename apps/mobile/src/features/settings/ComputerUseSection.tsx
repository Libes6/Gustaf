import { useAtomValue } from "@effect/atom-react";
import {
  computerUseEndReasonLabel,
  computerUseErrorMessage,
  computerUsePermissionLabel,
  computerUseRemoteView,
} from "@t3tools/client-runtime/state/computerUse";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseStatus, EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { computerUseEnvironment, useComputerUseStatus } from "../../state/computerUse";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/**
 * What the Mac an environment runs on allows agents. A phone reads this and can stop a running
 * session; turning control on and granting macOS permissions need a person at the Mac, so the
 * section says so instead of offering them.
 */
export function ComputerUseSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const status = useComputerUseStatus(props.environmentId);
  return status === null ? null : <ComputerUseRows {...props} status={status} />;
}

function ComputerUseRows({
  environmentId,
  label,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: ComputerUseStatus;
}) {
  const gt = useGT();
  const messages = useMessages();
  const canStop = useAtomValue(computerUseEnvironment.stop.permissionAtom(environmentId));
  const stop = useAtomCommand(computerUseEnvironment.stop, { reportFailure: false });
  const refresh = useAtomCommand(computerUseEnvironment.refresh, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const view = computerUseRemoteView(status);

  const run = async (
    task: () => Promise<AtomCommandResult<unknown, unknown>>,
    failureTitle: string,
  ) => {
    setBusy(true);
    const result = await task();
    setBusy(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        failureTitle,
        computerUseErrorMessage(squashAtomCommandFailure(result), messages),
      );
    }
  };

  const summary = (title: string, description: string) => (
    <View className="gap-1 p-4">
      <Text className="text-base text-foreground">{title}</Text>
      <Text className="text-sm text-foreground-muted">{description}</Text>
    </View>
  );

  return (
    <SettingsSection title={gt("Control Mac")}>
      {view.kind === "unsupported"
        ? summary(
            gt("Not available for {environment}", { environment: label }),
            gt(
              "An agent can control a Mac only through the Gustaf desktop app on that Mac, in the environment that app runs.",
            ),
          )
        : view.kind === "off"
          ? summary(
              gt("Off on the Mac that runs {environment}", { environment: label }),
              gt(
                "Turning it on needs a person at that Mac: open Gustaf there, then Settings › Control Mac.",
              ),
            )
          : view.kind === "grant-at-mac"
            ? summary(
                view.missing.length === 1
                  ? gt("Gustaf on the Mac still needs the {permission} permission.", {
                      permission: computerUsePermissionLabel(view.missing[0]!, messages),
                    })
                  : gt("Gustaf on the Mac still needs two permissions."),
                gt(
                  "Grant it in System Settings › Privacy & Security on that Mac. It can't be done from a phone.",
                ),
              )
            : view.kind === "check-failed"
              ? summary(
                  gt("Could not check permissions"),
                  gt(
                    "Gustaf could not ask macOS about its permissions. Check again; if it keeps failing, reopen Gustaf on the Mac.",
                  ),
                )
              : view.kind === "ready"
                ? summary(
                    gt("On, nobody is controlling the Mac"),
                    status.lastEndReason !== undefined
                      ? computerUseEndReasonLabel(status.lastEndReason, messages)
                      : gt(
                          "Allow a thread from its header in Gustaf on desktop or the web to let its agent start.",
                        ),
                  )
                : summary(
                    gt("The Mac is controlled by “{owner}”.", { owner: view.label }),
                    gt("Stop ends it at once. No key or button stays pressed."),
                  )}
      {view.kind === "check-failed" ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label={gt("Check again")}
          disabled={busy}
          loading={busy}
          onPress={() =>
            void run(() => refresh({ environmentId, input: {} }), gt("Could not check permissions"))
          }
        />
      ) : null}
      {view.kind === "active" ? (
        <SettingsActionRow
          icon="stop.fill"
          label={gt("Stop")}
          tone="danger"
          disabled={busy || !canStop}
          loading={busy}
          onPress={() =>
            void run(() => stop({ environmentId, input: {} }), gt("Could not stop control"))
          }
        />
      ) : null}
    </SettingsSection>
  );
}
