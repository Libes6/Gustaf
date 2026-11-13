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
  /** Distinct users with a device heartbeat or session refresh; today is the UTC day. */
  readonly activeUsers: {
    readonly today: number;
    readonly last7d: number;
    readonly last30d: number;
  };
  /** Active devices that reported a version, one row per kind, platform and version. */
  readonly versions: ReadonlyArray<{
    readonly kind: DeviceKind;
    readonly platform: string;
    readonly version: string;
    readonly devices: number;
  }>;
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
  /** Null until the app sends its first heartbeat. */
  readonly appVersion: string | null;
  readonly platform: string | null;
  readonly osVersion: string | null;
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

export type ReportStatus = "new" | "seen" | "closed";
export type ReportClient = "desktop" | "mobile";

export interface ReportSummary {
  readonly id: string;
  readonly userId: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly client: ReportClient;
  readonly appVersion: string;
  readonly platform: string;
  /** The first 200 characters of the message. */
  readonly preview: string;
  readonly hasLogs: boolean;
  readonly status: ReportStatus;
  readonly createdAt: string;
}

export interface ReportDetail extends Omit<ReportSummary, "preview"> {
  readonly message: string;
  readonly logs: string | null;
  readonly adminNote: string | null;
  readonly deviceId: string | null;
  readonly deviceName: string | null;
  readonly updatedAt: string;
}

export type ReportCounts = Readonly<Record<ReportStatus, number>>;

export type AuditAction =
  | "user.ban"
  | "user.unban"
  | "user.revoke_sessions"
  | "user.role_change"
  | "user.delete"
  | "device.revoke"
  | "report.update";

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

export type UsagePeriod = 1 | 7 | 30 | 90;

/** Token sums cover only `measuredTurns`; with none measured the token counts are unknown. */
export interface AiUsageCounts {
  readonly turns: number;
  readonly measuredTurns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AiUsageSummary {
  readonly days: UsagePeriod;
  /** First UTC day (`YYYY-MM-DD`) of the period, which ends today. */
  readonly from: string;
  readonly totals: AiUsageCounts & { readonly users: number };
  readonly byModel: ReadonlyArray<
    AiUsageCounts & {
      readonly provider: string;
      /** Null when the computer could not name a catalog model. */
      readonly model: string | null;
      readonly users: number;
    }
  >;
  readonly byUser: ReadonlyArray<
    AiUsageCounts & { readonly userId: string; readonly name: string; readonly email: string }
  >;
}
