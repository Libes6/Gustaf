export type Role = "user" | "admin";
export type DeviceKind = "computer" | "phone";

export interface Me {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly role: Role;
}

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor: string | null;
}

export interface Overview {
  readonly users: { readonly total: number; readonly last7d: number; readonly banned: number };
  readonly devices: {
    readonly total: number;
    readonly active7d: number;
    readonly byKind: { readonly computer: number; readonly phone: number };
  };
  readonly sessions: { readonly active: number };
  readonly signupsByDay: ReadonlyArray<{ readonly date: string; readonly count: number }>;
  readonly build: { readonly version: string; readonly commit: string; readonly startedAt: string };
  readonly db: { readonly ok: boolean; readonly migrations: number };
  readonly relay: { readonly bytesThisMonth: number; readonly users: number };
}

export interface AdminUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly githubLogin: string | null;
  readonly role: Role;
  readonly banned: boolean;
  readonly banReason: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  readonly deviceCount: number;
  readonly sessionCount: number;
}

export interface UserDevice {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly lastSeenAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
}

export interface UserSession {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface AdminUserDetail extends AdminUser {
  readonly devices: ReadonlyArray<UserDevice>;
  readonly sessions: ReadonlyArray<UserSession>;
  /** Bytes through the relay per UTC month (`YYYY-MM`), newest first. */
  readonly relay: ReadonlyArray<{ readonly month: string; readonly bytes: number }>;
}

export interface AdminDevice extends UserDevice {
  readonly userId: string;
  readonly userName: string;
}

export type AuditAction =
  | "user.ban"
  | "user.unban"
  | "user.revoke_sessions"
  | "user.role_change"
  | "user.delete"
  | "device.revoke";

export interface AuditEntry {
  readonly id: string;
  readonly at: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly action: AuditAction | (string & {});
  readonly targetType: string;
  readonly targetId: string;
  readonly meta: unknown;
}

/** Relay outcome names, in the API's order; see apps/api/src/relay/relay.hub.ts. */
export const RELAY_FAILURES = [
  "rate_limited",
  "hello_timeout",
  "bad_hello",
  "unauthorized",
  "unavailable",
  "not_a_computer",
  "socket_limit",
  "host_offline",
  "channel_limit",
  "budget_exceeded",
  "protocol_error",
  "too_slow",
  "revoked",
] as const;
export type RelayFailure = (typeof RELAY_FAILURES)[number];
export type RelayEvent = "attempt" | "connected" | "channel_opened" | RelayFailure;

export interface RelayHealth {
  readonly live: {
    readonly hostsOnline: number;
    readonly clientsOnline: number;
    readonly openTunnels: number;
    readonly since: string;
    readonly counts: Readonly<Record<RelayEvent, number>>;
  };
  readonly monthlyLimitBytes: number;
  /** The last 30 UTC days, oldest first. */
  readonly days: ReadonlyArray<
    { readonly date: string; readonly bytes: number } & Readonly<Record<RelayEvent, number>>
  >;
  readonly topUsers: ReadonlyArray<{
    readonly userId: string;
    readonly name: string;
    readonly githubLogin: string | null;
    readonly bytes: number;
    readonly percent: number;
  }>;
}

export type BackupStatus =
  | { readonly status: "not_configured" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ok";
      readonly fetchedAt: string;
      readonly schedules: number;
      readonly enabled: number;
      readonly frequency: string | null;
      readonly last: {
        readonly status: string;
        readonly startedAt: string;
        readonly finishedAt: string | null;
        readonly sizeBytes: number | null;
      } | null;
    };

export interface SystemStatus {
  readonly build: {
    readonly version: string;
    readonly commit: string;
    readonly startedAt: string;
    readonly uptimeSeconds: number;
    readonly node: string;
  };
  readonly memory: {
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly heapTotalBytes: number;
    readonly externalBytes: number;
  };
  readonly disk: { readonly totalBytes: number; readonly freeBytes: number } | null;
  readonly database: {
    readonly sizeBytes: number;
    readonly tables: ReadonlyArray<{
      readonly name: string;
      readonly bytes: number;
      readonly rows: number | null;
    }>;
  } | null;
  readonly backups: BackupStatus;
}

export type Platform = "macos" | "windows" | "linux" | "android" | "ios" | "other";

export interface ReleaseAsset {
  readonly name: string;
  readonly platform: Platform;
  readonly kind: "installer" | "update" | "metadata";
  readonly downloads: number;
  readonly sizeBytes: number;
}

export type ReleaseStats =
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ok";
      readonly fetchedAt: string;
      readonly total: number;
      readonly byPlatform: Readonly<
        Record<Platform, { readonly installer: number; readonly update: number }>
      >;
      readonly releases: ReadonlyArray<{
        readonly tag: string;
        readonly name: string | null;
        readonly publishedAt: string | null;
        readonly prerelease: boolean;
        readonly downloads: number;
        readonly assets: ReadonlyArray<ReleaseAsset>;
      }>;
    };
