import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useT } from "../../useUiLanguage";

const FAILURE_TITLES = {
  install: "settingsA.cliCommand.couldNotInstall",
  uninstall: "settingsA.cliCommand.couldNotRemove",
  addToPath: "settingsA.cliCommand.couldNotAddToPath",
} as const;

/** The desktop `gustaf` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const t = useT();
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t(FAILURE_TITLES[action]),
            description:
              error instanceof Error ? error.message : t("settingsA.cliCommand.somethingWrong"),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const t = useT();
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? t("settingsA.cliCommand.shadowed").replace("{path}", state.shadowedBy)
    : !installed
      ? t("settingsA.cliCommand.runHint")
      : state.onPath
        ? t("settingsA.cliCommand.installedOpenTerminal").replace(
            "{path}",
            state.installedPath ?? "",
          )
        : state.pathSetup?.added
          ? t("settingsA.cliCommand.installedAddedToPath")
              .replace("{path}", state.installedPath ?? "")
              .replace("{file}", state.pathSetup.file)
          : `${t("settingsA.cliCommand.notOnPath").replace("{path}", state.installedPath ?? "")}${state.pathSetup ? "" : ` ${t("settingsA.cliCommand.addToPathHint")}`}`;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              {t("settingsA.cliCommand.addToPath")}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed ? t("settingsA.cliCommand.remove") : t("settingsA.cliCommand.install")}
          </Button>
        </div>
      }
    />
  );
}
