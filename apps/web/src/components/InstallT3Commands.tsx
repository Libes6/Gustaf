import { cliInstallCommand } from "@t3tools/shared/cliRelease";

import { cn } from "~/lib/utils";

import { useT } from "../useUiLanguage";
import { CommandBlock } from "./CommandBlock";

/**
 * Setup steps for another computer: install `gustaf`, then run `command`. Both installers are shown
 * because the browser showing this is often not the computer being set up.
 */
export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  const t = useT();
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">{t("shell.installT3.macOsLinux")}</p>
      <CommandBlock command={cliInstallCommand("linux")} />
      <p className="text-xs text-muted-foreground">{t("shell.installT3.windowsPowerShell")}</p>
      <CommandBlock command={cliInstallCommand("win32")} />
      <p className="text-xs text-muted-foreground">{t("shell.installT3.then")}</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">{t("shell.installT3.skipHint")}</p>
    </div>
  );
}
