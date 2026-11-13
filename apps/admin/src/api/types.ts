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
  | "device.revoke"
  | "announcement.create"
  | "announcement.update"
  | "announcement.delete"
  | "minimum_version.set"
  | "minimum_version.clear"
  | "feature_flag.create"
  | "feature_flag.update"
  | "feature_flag.delete";

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

export type ClientKind = "desktop" | "mobile";
export type ClientTarget = "all" | ClientKind;
export type AnnouncementLevel = "info" | "warning" | "critical";
export type FlagMode = "off" | "everyone" | "listed";

/** What the admin sends for an announcement; create and edit send the whole record. */
export interface AnnouncementInput {
  readonly textEn: string;
  readonly textRu: string;
  readonly level: AnnouncementLevel;
  readonly link: string | null;
  readonly target: ClientTarget;
  readonly minVersion: string | null;
  readonly maxVersion: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly active: boolean;
}

export interface Announcement extends AnnouncementInput {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MinimumVersion {
  readonly kind: ClientKind;
  readonly version: string;
  readonly message: string | null;
  readonly updatedAt: string;
}

export interface FeatureFlagInput {
  readonly description: string;
  readonly mode: FlagMode;
  readonly logins: ReadonlyArray<string>;
}

export interface FeatureFlag extends FeatureFlagInput {
  readonly key: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
