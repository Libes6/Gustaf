import { useAtomValue } from "@effect/atom-react";
import {
  computerUseEndReasonLabel,
  computerUseErrorMessage,
  computerUseHasStopShortcut,
  computerUseIsOn,
  computerUseMissingPermissions,
  computerUsePermissionLabel,
  computerUseProviderList,
} from "@t3tools/client-runtime/state/computerUse";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComputerUsePermission, ComputerUseStatus } from "@t3tools/contracts";
import { T, useGT, useLocale, useMessages, Var } from "gt-react";
import { useState } from "react";

import {
  computerUseEnvironment,
  useComputerUsePermissionRecheck,
  useComputerUseStatus,
} from "../../state/computerUse";
import type { EnvironmentPresentation } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PERMISSIONS: ReadonlyArray<ComputerUsePermission> = ["screen-recording", "accessibility"];

export function ComputerUseSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <EnvironmentComputerUse key={environment.environmentId} environment={environment} />
      ) : (
        <SettingsSection {...searchableSetting("computer-use")} title={gt("Control Mac")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            <T>Connect an environment to see whether agents can control its Mac.</T>
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

function EnvironmentComputerUse({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const status = useComputerUseStatus(environment.environmentId);
  return status === null ? null : <ComputerUseSections environment={environment} status={status} />;
}

function ComputerUseSections({
  environment,
  status,
}: {
  readonly environment: EnvironmentPresentation;
  readonly status: ComputerUseStatus;
}) {
  const gt = useGT();
  const messages = useMessages();
  const language = useLocale();
  const searchableSetting = useSearchableSetting();
  const environmentId = environment.environmentId;
  const canWrite = useAtomValue(computerUseEnvironment.setEnabled.permissionAtom(environmentId));
  const canOperate = useAtomValue(
    computerUseEnvironment.openPermissionSettings.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(computerUseEnvironment.setEnabled, { reportFailure: false });
  const openSettings = useAtomCommand(computerUseEnvironment.openPermissionSettings, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(computerUseEnvironment.refresh, { reportFailure: false });
  const stop = useAtomCommand(computerUseEnvironment.stop, { reportFailure: false });
  const [busy, setBusy] = useState<null | "toggle" | "stop" | "other">(null);
  const [error, setError] = useState<string | null>(null);

  const isOn = computerUseIsOn(status);
  const missing = computerUseMissingPermissions(status);
  useComputerUsePermissionRecheck(
    environmentId,
    status.availability === "permissions-required" && missing !== null && missing.length > 0,
  );

  const run = async (
    kind: "toggle" | "stop" | "other",
    task: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(kind);
    setError(null);
    const result = await task();
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setError(computerUseErrorMessage(squashAtomCommandFailure(result), messages));
    }
    setBusy(null);
  };

  if (status.availability === "unsupported") {
    return (
      <SettingsSection {...searchableSetting("computer-use")} title={gt("Control Mac")}>
        <SettingsRow
          title={gt("Not available for {environment}", { environment: environment.label })}
          description={gt(
            "An agent can control a Mac only through the Gustaf desktop app on that Mac, in the environment that app runs.",
          )}
        />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection {...searchableSetting("computer-use")} title={gt("Control Mac")}>
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          <T>
            Lets an agent in a thread you allow see the screen of the Mac that runs{" "}
            <Var>{environment.label}</Var> and use its mouse and keyboard. It works with{" "}
            <Var>{computerUseProviderList(language, messages)}</Var>, and one thread at a time.
          </T>
        </p>
        <SettingsRow
          title={gt("Allow agents to control the Mac")}
          description={
            isOn
              ? gt("A thread still needs your Allow in its header before an agent can start.")
              : gt(
                  "Turning it on asks the person at the Mac to confirm in a dialog on that Mac. Only they can.",
                )
          }
          status={
            busy === "toggle" && !isOn ? gt("Waiting for the person at the Mac to confirm…") : null
          }
          control={
            <Switch
              checked={isOn}
              disabled={!canWrite || busy !== null}
              aria-label={gt("Allow agents to control the Mac")}
              onCheckedChange={(enabled) =>
                void run("toggle", () => setEnabled({ environmentId, input: { enabled } }))
              }
            />
          }
        />
        {error !== null ? (
          <p role="alert" className="px-4 py-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      {isOn ? (
        <>
          <SettingsSection title={gt("macOS permissions")}>
            {missing === null ? (
              <SettingsRow
                title={gt("Could not check permissions")}
                description={gt(
                  "Gustaf could not ask macOS about its permissions. Check again; if it keeps failing, reopen Gustaf on the Mac.",
                )}
                control={
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void run("other", () => refresh({ environmentId, input: {} }))}
                  >
                    <T>Check again</T>
                  </Button>
                }
              />
            ) : (
              PERMISSIONS.map((permission) => {
                const granted = !missing.includes(permission);
                return (
                  <SettingsRow
                    key={permission}
                    title={computerUsePermissionLabel(permission, messages)}
                    status={
                      <Badge variant={granted ? "success" : "warning"}>
                        {granted ? gt("Granted") : gt("Needs access")}
                      </Badge>
                    }
                    control={
                      granted ? null : (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!canOperate || busy !== null}
                          onClick={() =>
                            void run("other", () =>
                              openSettings({ environmentId, input: { permission } }),
                            )
                          }
                        >
                          <T>Open settings</T>
                        </Button>
                      )
                    }
                  />
                );
              })
            )}
            {missing !== null && missing.length > 0 ? (
              <p className="px-4 py-3 text-xs text-muted-foreground">
                <T>
                  Switch Gustaf on in the list that opens on the Mac. This page notices on its own.
                  If macOS asks for a permission again, or Gustaf already looks switched on, remove
                  the Gustaf entries with −, then click Open settings again.
                </T>
              </p>
            ) : null}
          </SettingsSection>
          <SettingsSection title={gt("Session")}>
            <SettingsRow
              title={
                status.owner === undefined
                  ? gt("No thread controls the Mac")
                  : gt("The Mac is controlled by “{owner}”.", { owner: status.owner.label })
              }
              description={
                status.owner === undefined && status.lastEndReason !== undefined
                  ? computerUseEndReasonLabel(status.lastEndReason, messages)
                  : computerUseHasStopShortcut(status)
                    ? gt(
                        "To stop: Stop in the thread header, Stop control in the Mac's menu bar, or {shortcut} on the Mac.",
                        { shortcut: status.emergencyShortcut },
                      )
                    : undefined
              }
              control={
                status.owner === undefined ? null : (
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={!canOperate || busy !== null}
                    onClick={() => void run("stop", () => stop({ environmentId, input: {} }))}
                  >
                    <T>Stop</T>
                  </Button>
                )
              }
            />
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}
