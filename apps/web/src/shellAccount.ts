/** The Gustaf cloud account, as the Tauri shell exposes it. The shell keeps the session token. */
export interface ShellAccountUser {
  readonly id: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly image: string | null;
}

export interface ShellAccountState {
  readonly signedIn: boolean;
  readonly user: ShellAccountUser | null;
  readonly expiresAt: string | null;
  /** The cloud device this computer registered as, when it has. */
  readonly deviceId: string | null;
}

export interface ShellAccountDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  /** This computer's own registration. */
  readonly current: boolean;
}

export interface ShellAccount {
  readonly getState: () => Promise<ShellAccountState>;
  /** Resolves once the browser sign-in finishes, fails, times out or is cancelled. */
  readonly signIn: () => Promise<ShellAccountState>;
  readonly cancelSignIn: () => Promise<void>;
  readonly signOut: () => Promise<ShellAccountState>;
  readonly listDevices: () => Promise<readonly ShellAccountDevice[]>;
  readonly registerThisComputer: () => Promise<ShellAccountState>;
  readonly revokeDevice: (deviceId: string) => Promise<ShellAccountState>;
}

export function shellAccount(): ShellAccount | undefined {
  return typeof window === "undefined" ? undefined : window.gustafShell?.account;
}

/** The shell installs before web code runs, so module-load detection is reliable. */
export const hasShellAccount = shellAccount() !== undefined;
