import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { acceptsTrackSwitchRelease, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { npmReleaseAtom, npmReleaseFailureMessage } from "~/state/npmRelease";
import { downloadLocalUpdate, installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import { UpdateEverythingDialog } from "../sidebar/UpdateEverythingDialog";
import {
  channelSwitchLabel,
  localSwitchBlockReason,
  type ChannelSwitchRelease,
} from "../sidebar/updateEverything.logic";
import { isHostedByThisApp, useUpdateEverything } from "../sidebar/useUpdateEverything";
import { localUpdaterStaysPut, prepareLocalTrackSwitch } from "./updateTrackSwitch.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useT } from "../../useUiLanguage";

/** Moves this app and every connected machine to `channel`. */
export function UpdateTrackSwitchDialog({
  channel,
  onClose,
}: {
  readonly channel: DesktopUpdateChannel;
  readonly onClose: () => void;
}) {
  const t = useT();
  // npm dist-tags match the desktop channel names.
  const release = useAtomValue(npmReleaseAtom(channel));
  if (AsyncResult.isSuccess(release) && release.value !== null) {
    return <SwitchPlan release={{ channel, ...release.value }} onClose={onClose} />;
  }
  const label = channelSwitchLabel(channel);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("settingsE.updateTrackSwitchDialog.switchTo").replace("{label}", label)}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {AsyncResult.isFailure(release)
              ? npmReleaseFailureMessage(release.cause)
              : AsyncResult.isSuccess(release)
                ? t("settingsE.updateTrackSwitchDialog.notFound").replace("{label}", label)
                : t("settingsE.updateTrackSwitchDialog.checking")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>
            {t("settingsE.updateTrackSwitchDialog.cancel")}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SwitchPlan({
  release,
  onClose,
}: {
  readonly release: ChannelSwitchRelease;
  readonly onClose: () => void;
}) {
  const t = useT();
  const updateState = useDesktopUpdateState();
  const { environments } = useEnvironments();
  const crossesLocal = desktopUpdateChannelOf(APP_VERSION) !== release.channel;
  const updatesOff = localUpdaterStaysPut(updateState, release.channel);
  // After a partial switch this app may already be on the track; then only remotes move.
  const switchesLocal = crossesLocal && !updatesOff;
  const [checking, setChecking] = useState(false);
  const everything = useUpdateEverything(switchesLocal ? release.version : null, release);
  const label = channelSwitchLabel(release.channel);
  // This app's reinstall restarts every server it hosts, so each of their databases must allow it.
  const localBlocked = localSwitchBlockReason(
    APP_VERSION,
    release,
    environments.filter(isHostedByThisApp).map((environment) => ({
      connected: environment.connection.phase === "connected",
      databaseMigration: environment.serverConfig?.environment.databaseMigration,
    })),
    window.desktopBridge?.getLocalEnvironmentBootstraps().length ?? 0,
  );

  const run = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Stay open while the feed is checked; the run's own progress takes over after.
    setChecking(true);
    const fail = (description: string) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("settingsE.updateTrackSwitchDialog.switchFailed").replace("{label}", label),
          description,
        }),
      );
    const prepared = await prepareLocalTrackSwitch(bridge, {
      channel: release.channel,
      version: release.version,
      reinstall: switchesLocal,
    });
    onClose();
    if (!prepared.ok) {
      fail(prepared.message);
      return;
    }
    const { local } = prepared;
    const result = await settlePromise(() =>
      everything.run(
        local === null
          ? {}
          : {
              ...(local.status === "available"
                ? {
                    downloadLocal: (reportError) =>
                      downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
                  }
                : {}),
              // Install only a build the database check covers, pinned so nothing replaces it.
              installLocal: async (reportError) => {
                const { downloadedVersion } = await bridge.getUpdateState();
                if (
                  downloadedVersion === null ||
                  !acceptsTrackSwitchRelease(downloadedVersion, release.channel, release.version)
                ) {
                  reportError(
                    t("settingsE.updateTrackSwitchDialog.installFailed"),
                    t("settingsE.updateTrackSwitchDialog.downloadedOther")
                      .replace(
                        "{downloaded}",
                        downloadedVersion ?? t("settingsE.updateTrackSwitchDialog.nothing"),
                      )
                      .replace("{version}", release.version),
                  );
                  return false;
                }
                return installLocalUpdate(bridge, reportError, downloadedVersion);
              },
            },
      ),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      fail(
        error instanceof Error
          ? error.message
          : t("settingsE.updateTrackSwitchDialog.unexpectedError"),
      );
    }
  };

  return (
    <UpdateEverythingDialog
      open
      onOpenChange={(open) => !open && !checking && onClose()}
      title={t("settingsE.updateTrackSwitchDialog.switchToTitle").replace("{label}", label)}
      version={release.version}
      providerCount={0}
      rows={everything.rows}
      notes={[
        ...(everything.rows.length === 0 && !crossesLocal
          ? [t("settingsE.updateTrackSwitchDialog.alreadyOn").replace("{label}", label)]
          : []),
        ...(crossesLocal && updatesOff ? [t("settingsE.updateTrackSwitchDialog.updatesOff")] : []),
        ...(switchesLocal && isMacPlatform(navigator.platform)
          ? [t("settingsE.updateTrackSwitchDialog.reopen")]
          : []),
      ]}
      restarts={everything.restarts}
      confirmLabel={
        checking
          ? t("settingsE.updateTrackSwitchDialog.checkingShort")
          : t("settingsE.updateTrackSwitchDialog.switchTo").replace("{label}", label)
      }
      busy={checking}
      disabledReason={
        !switchesLocal || localBlocked === null
          ? null
          : t("settingsE.updateTrackSwitchDialog.cannotSwitch").replace("{reason}", localBlocked)
      }
      onConfirm={() => void run()}
    />
  );
}
