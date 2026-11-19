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

/** This computer as a Gustaf relay client: its device credential and two durable entries. */
export interface ShellRelayClient {
  readonly credential: () => Promise<{
    readonly deviceId: string;
    readonly deviceToken: string;
    readonly deviceName: string;
  }>;
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
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
  /** Sends a problem report with the account session; logs are read, redacted and capped by the shell. */
  readonly reportProblem: (report: {
    readonly message: string;
    readonly attachLogs: boolean;
  }) => Promise<void>;
  /** Absent in shells older than the desktop relay client. */
  readonly relayClient?: ShellRelayClient;
}

export function shellAccount(): ShellAccount | undefined {
  return typeof window === "undefined" ? undefined : window.gustafShell?.account;
}

/** The shell installs before web code runs, so module-load detection is reliable. */
export const hasShellAccount = shellAccount() !== undefined;
