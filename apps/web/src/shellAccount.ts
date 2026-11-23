import type {
  DesktopGustafAccountBridge,
  DesktopGustafRelayClientBridge,
  GustafAccountDevice,
  GustafAccountState,
  GustafCloudUser,
} from "@t3tools/contracts";

/** The Gustaf cloud account, as the desktop shell exposes it. The shell keeps the session token. */
export type ShellAccountUser = GustafCloudUser;
export type ShellAccountState = GustafAccountState;
export type ShellAccountDevice = GustafAccountDevice;
export type ShellRelayClient = DesktopGustafRelayClientBridge;
export type ShellAccount = DesktopGustafAccountBridge;

export function shellAccount(): ShellAccount | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.gustafAccount;
}

/** The preload installs before web code runs, so module-load detection is reliable. */
export const hasShellAccount = shellAccount() !== undefined;
