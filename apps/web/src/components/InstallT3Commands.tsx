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
      <CommandBlock command="curl -fsSL https://t3.codes/install.sh | sh" />
      <p className="text-xs text-muted-foreground">{t("shell.installT3.windowsPowerShell")}</p>
      <CommandBlock command="irm https://t3.codes/install.ps1 | iex" />
      <p className="text-xs text-muted-foreground">{t("shell.installT3.then")}</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Skip the install if you already have <code className="font-mono">gustaf</code>. If{" "}
        <code className="font-mono">gustaf</code> is not found after installing, add the folder the
        installer names to your PATH.
      </p>
    </div>
  );
}
