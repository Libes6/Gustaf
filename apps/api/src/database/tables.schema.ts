import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Better Auth core tables (user, session, account, verification); property names are the
// field names the library expects, columns are snake_case.
const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  // Better Auth admin plugin fields (role, ban).
  role: text("role").notNull().default("user"),
  banned: boolean("banned").notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  // Ours, unknown to Better Auth: refreshed from the GitHub profile on every sign-in.
  githubLogin: text("github_login"),
  ...timestamps,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // Admin plugin field; impersonation is never enabled, so it stays null.
    impersonatedBy: text("impersonated_by"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (table) => [index("session_user_id_idx").on(table.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [index("account_user_id_idx").on(table.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// Device credentials are separate from user sessions: one hashed token per device.
export const deviceKind = pgEnum("device_kind", ["computer", "phone"]);

export const device = pgTable(
  "device",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: deviceKind("kind").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    tokenRotatedAt: timestamp("token_rotated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // Reported by the app's heartbeat; null until the device first sends one.
    appVersion: text("app_version"),
    platform: text("platform"),
    osVersion: text("os_version"),
    // Set by an admin; the row stays for the admin view, the token stops working.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [index("device_user_id_idx").on(table.userId)],
);

// App sign-in handoff (docs/internals/app-sign-in.md). The request id and the code are stored
// only as SHA-256 hashes; expired rows are deleted by the next write.
export const appSignInRequest = pgTable(
  "app_sign_in_request",
  {
    id: text("id").primaryKey(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("app_sign_in_request_expires_at_idx").on(table.expiresAt)],
);

export const appAuthCode = pgTable(
  "app_auth_code",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => session.id, { onDelete: "cascade" }),
    codeChallenge: text("code_challenge").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [index("app_auth_code_expires_at_idx").on(table.expiresAt)],
);

// Admin mutations. The actor is not a foreign key so the trail outlives deleted accounts.
export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
});

// Relay traffic per user and calendar month (UTC), counted in bytes; the relay never sees content.
export const relayUsage = pgTable(
  "relay_usage",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    bytes: bigint("bytes", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.month] })],
);

// Relay totals per UTC day: bytes and connection outcomes by metric name (relay.daily.ts).
// Aggregate only; no user, device or address is stored.
export const relayDaily = pgTable(
  "relay_daily",
  {
    day: date("day", { mode: "string" }).notNull(),
    metric: text("metric").notNull(),
    value: bigint("value", { mode: "number" }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.day, table.metric] })],
);

// "Report a problem" from the apps. Logs are only present when the user chose to attach them.
export const bugReportClient = pgEnum("bug_report_client", ["desktop", "mobile"]);
export const bugReportStatus = pgEnum("bug_report_status", ["new", "seen", "closed"]);

export const bugReport = pgTable(
  "bug_report",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id").references(() => device.id, { onDelete: "set null" }),
    client: bugReportClient("client").notNull(),
    appVersion: text("app_version").notNull(),
    platform: text("platform").notNull(),
    message: text("message").notNull(),
    logs: text("logs"),
    status: bugReportStatus("status").notNull().default("new"),
    adminNote: text("admin_note"),
    ...timestamps,
  },
  (table) => [
    index("bug_report_status_created_at_idx").on(table.status, table.createdAt),
    index("bug_report_user_id_created_at_idx").on(table.userId, table.createdAt),
  ],
);

// AI usage counted by each user's computers (docs/internals/ai-usage.md). One row per user, UTC
// day, provider and model; `model` is '' when the computer could not name a catalog model.
// Token sums cover only the `measured_turns` whose provider reported both counts.
export const aiUsageDaily = pgTable(
  "ai_usage_daily",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    turns: bigint("turns", { mode: "number" }).notNull(),
    measuredTurns: bigint("measured_turns", { mode: "number" }).notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day, table.provider, table.model] }),
    // Global summaries filter on the day range alone.
    index("ai_usage_daily_day_idx").on(table.day),
    check(
      "ai_usage_daily_counts_check",
      sql`${table.turns} >= 0 and ${table.measuredTurns} between 0 and ${table.turns} and ${table.inputTokens} >= 0 and ${table.outputTokens} >= 0`,
    ),
  ],
);

// Report batches already added to ai_usage_daily, so a retried upload counts once.
export const aiUsageReport = pgTable(
  "ai_usage_report",
  {
    deviceId: uuid("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.batchId] }),
    index("ai_usage_report_received_at_idx").on(table.receivedAt),
  ],
);
