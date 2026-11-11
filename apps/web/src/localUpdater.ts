import type { DesktopBridge } from "@t3tools/contracts";

/** The calls that update the app this window belongs to. */
export type LocalUpdater = Pick<
  DesktopBridge,
  | "getUpdateState"
  | "onUpdateState"
  | "checkForUpdate"
  | "downloadUpdate"
  | "installUpdate"
  | "openExternal"
>;

/** Electron's bridge, or the Gustaf shell's updater; a browser tab has neither. */
export function localUpdater(): LocalUpdater | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge ?? window.gustafShell?.updater;
}

/** The shell installs before web code runs, so module-load detection is reliable, as for isElectron. */
export const hasShellUpdater =
  typeof window !== "undefined" && window.gustafShell?.updater !== undefined;

/** The shell's release version; the web client's own version is not the installed app's. */
export function installedAppVersion(fallback: string): string {
  return (typeof window === "undefined" ? undefined : window.gustafShell?.version) ?? fallback;
}
