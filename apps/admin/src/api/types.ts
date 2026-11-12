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
