import * as NodeFS from "node:fs";
import { NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { auditLog, device, relayUsage, session, user } from "../database/tables.schema.js";
import { usageMonth } from "../relay/relay.usage.js";
import { assertNotSelf, decodeCursor, type Role, toPage } from "./admin-rules.js";

type AuditAction =
  | "user.ban"
  | "user.unban"
  | "user.revoke_sessions"
  | "user.role_change"
  | "user.delete"
  | "device.revoke";

type Page = { limit: number; cursor: string | undefined };
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const journal = new URL("../../drizzle/meta/_journal.json", import.meta.url);

interface BuildInfo {
  version: string;
  commit: string;
}

// Postgres keeps microseconds; the cursor carries the timestamp as text so no row is skipped.
const createdAtKey = (column: typeof user.createdAt | typeof device.createdAt) =>
  sql<string>`${column}::text`;
const keysetBefore = (
  column: typeof user.createdAt | typeof device.createdAt,
  id: typeof user.id | typeof device.id,
  cursor: string | undefined,
) => {
  if (!cursor) return undefined;
  const [at, key] = decodeCursor(cursor, 2);
  return sql`(${column}, ${id}) < (${String(at)}::timestamptz, ${String(key)})`;
};

// Correlated subqueries are spelled out: Drizzle leaves single-table columns unqualified.
const activeSessions = sql<number>`(select count(*)::int from session s where s.user_id = "user".id and s.expires_at > now())`;
const activeDevices = sql<number>`(select count(*)::int from device d where d.user_id = "user".id and d.revoked_at is null)`;
const lastSeen = sql<Date | null>`greatest(
  (select max(s.updated_at) from session s where s.user_id = "user".id),
  (select max(d.last_seen_at) from device d where d.user_id = "user".id)
)`.mapWith(user.createdAt);

const userColumns = {
  id: user.id,
  name: user.name,
  email: user.email,
  image: user.image,
  githubLogin: user.githubLogin,
  role: user.role,
  banned: user.banned,
  banReason: user.banReason,
  createdAt: user.createdAt,
  lastSeenAt: lastSeen,
  deviceCount: activeDevices,
  sessionCount: activeSessions,
};

const deviceColumns = {
  id: device.id,
  name: device.name,
  kind: device.kind,
  userId: device.userId,
  userName: user.name,
  lastSeenAt: device.lastSeenAt,
  createdAt: device.createdAt,
  revokedAt: device.revokedAt,
  appVersion: device.appVersion,
  platform: device.platform,
  osVersion: device.osVersion,
};

function withoutCursor<Row extends { cursorAt: string }>({ cursorAt: _cursorAt, ...row }: Row) {
  return row;
}

// Constructed by a factory in app.ts, which passes the build info.
export class AdminService {
  private readonly startedAt = new Date();
  private readonly bundledMigrations = (
    JSON.parse(NodeFS.readFileSync(journal, "utf8")) as { entries: unknown[] }
  ).entries.length;

  constructor(
    private readonly database: DatabaseService,
    private readonly build: BuildInfo,
  ) {}

  async overview() {
    const db = this.database.db;
    const weekAgo = new Date(Date.now() - 7 * DAY_MS);
    const [[users], [devices], [sessions], [relay], signups, migrations, [active], versions] =
      await Promise.all([
        db
          .select({
            total: count(),
            last7d: sql<number>`count(*) filter (where ${user.createdAt} > ${weekAgo})`.mapWith(
              Number,
            ),
            banned: sql<number>`count(*) filter (where ${user.banned})`.mapWith(Number),
          })
          .from(user),
        db
          .select({
            total: count(),
            active7d:
              sql<number>`count(*) filter (where ${device.lastSeenAt} > ${weekAgo})`.mapWith(
                Number,
              ),
            computer: sql<number>`count(*) filter (where ${device.kind} = 'computer')`.mapWith(
              Number,
            ),
            phone: sql<number>`count(*) filter (where ${device.kind} = 'phone')`.mapWith(Number),
          })
          .from(device)
          .where(isNull(device.revokedAt)),
        db
          .select({ active: count() })
          .from(session)
          .where(gt(session.expiresAt, sql`now()`)),
        db
          .select({
            bytesThisMonth: sql<number>`coalesce(sum(${relayUsage.bytes}), 0)`.mapWith(Number),
            users: count(),
          })
          .from(relayUsage)
          .where(eq(relayUsage.month, usageMonth())),
        // UTC calendar days, today included, zero-filled.
        db.execute<{ date: string; count: number }>(sql`
        select to_char(day, 'YYYY-MM-DD') as date, count(${user.id})::int as count
        from generate_series(
          (now() at time zone 'utc')::date - 29, (now() at time zone 'utc')::date, interval '1 day'
        ) as day
        left join ${user} on (${user.createdAt} at time zone 'utc')::date = day::date
        group by day order by day`),
        db.execute<{ applied: number }>(
          sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
        ),
        // A user is active when a device of theirs authenticated or a session was refreshed.
        db
          .execute<{ today: number; last7d: number; last30d: number }>(sql`
        with activity as (
          select ${device.userId} as user_id, ${device.lastSeenAt} as at from ${device}
          where ${device.lastSeenAt} > now() - interval '30 days'
          union all
          select ${session.userId}, ${session.updatedAt} from ${session}
          where ${session.updatedAt} > now() - interval '30 days'
        )
        select
          count(distinct user_id) filter (
            where at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
          )::int as today,
          count(distinct user_id) filter (where at > now() - interval '7 days')::int as last7d,
          count(distinct user_id)::int as last30d
        from activity`)
          .then((result) => result.rows),
        db
          .select({
            kind: device.kind,
            platform: sql<string>`${device.platform}`,
            version: sql<string>`${device.appVersion}`,
            devices: count(),
          })
          .from(device)
          .where(and(isNull(device.revokedAt), isNotNull(device.appVersion)))
          .groupBy(device.kind, device.platform, device.appVersion)
          .orderBy(device.kind, device.platform, device.appVersion),
      ]);
    const applied = migrations.rows[0]?.applied ?? 0;
    return {
      users: users!,
      devices: {
        total: devices!.total,
        active7d: devices!.active7d,
        byKind: { computer: devices!.computer, phone: devices!.phone },
      },
      sessions: sessions!,
      relay: relay!,
      signupsByDay: signups.rows.map(({ date, count }) => ({ date, count })),
      activeUsers: active!,
      versions,
      build: { ...this.build, startedAt: this.startedAt },
      db: { ok: applied >= this.bundledMigrations, migrations: applied },
    };
  }

  async listUsers(search: string | undefined, page: Page) {
    const rows = await this.database.db
      .select({ ...userColumns, cursorAt: createdAtKey(user.createdAt) })
      .from(user)
      .where(
        and(
          search
            ? or(
                ilike(user.name, search),
                ilike(user.email, search),
                ilike(user.githubLogin, search),
              )
            : undefined,
          keysetBefore(user.createdAt, user.id, page.cursor),
        ),
      )
      .orderBy(desc(user.createdAt), desc(user.id))
      .limit(page.limit + 1);
    return toPage(rows, page.limit, withoutCursor, (row) => [row.cursorAt, row.id]);
  }

  async getUser(id: string) {
    const db = this.database.db;
    const [row] = await db.select(userColumns).from(user).where(eq(user.id, id));
    if (!row) throw new NotFoundException();
    const [devices, sessions, relay] = await Promise.all([
      db
        .select(deviceColumns)
        .from(device)
        .innerJoin(user, eq(user.id, device.userId))
        .where(eq(device.userId, id))
        .orderBy(desc(device.createdAt)),
      db
        .select({
          id: session.id,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        })
        .from(session)
        .where(and(eq(session.userId, id), gt(session.expiresAt, sql`now()`)))
        .orderBy(desc(session.createdAt)),
      // Bytes through the relay per UTC month, newest first; the relay never sees content.
      db
        .select({ month: relayUsage.month, bytes: relayUsage.bytes })
        .from(relayUsage)
        .where(eq(relayUsage.userId, id))
        .orderBy(desc(relayUsage.month))
        .limit(12),
    ]);
    return { ...row, devices, sessions, relay };
  }

  async listDevices(
    search: string | undefined,
    kind: "computer" | "phone" | undefined,
    page: Page,
  ) {
    const rows = await this.database.db
      .select({ ...deviceColumns, cursorAt: createdAtKey(device.createdAt) })
      .from(device)
      .innerJoin(user, eq(user.id, device.userId))
      .where(
        and(
          kind ? eq(device.kind, kind) : undefined,
          search
            ? or(ilike(device.name, search), ilike(user.name, search), ilike(user.email, search))
            : undefined,
          keysetBefore(device.createdAt, device.id, page.cursor),
        ),
      )
      .orderBy(desc(device.createdAt), desc(device.id))
      .limit(page.limit + 1);
    return toPage(rows, page.limit, withoutCursor, (row) => [row.cursorAt, row.id]);
  }

  async listAudit(page: Page) {
    const before = page.cursor ? Number(decodeCursor(page.cursor, 1)[0]) : undefined;
    const rows = await this.database.db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        actorId: auditLog.actorId,
        actorName: user.name,
        action: auditLog.action,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        meta: auditLog.meta,
      })
      .from(auditLog)
      .leftJoin(user, eq(user.id, auditLog.actorId))
      .where(Number.isSafeInteger(before) ? sql`${auditLog.id} < ${before}` : undefined)
      .orderBy(desc(auditLog.id))
      .limit(page.limit + 1);
    return toPage(
      rows,
      page.limit,
      (row) => row,
      (row) => [row.id],
    );
  }

  ban(actorId: string, id: string, reason: string | null) {
    assertNotSelf(actorId, id);
    return this.mutateUser(actorId, id, "user.ban", { reason }, async (tx) => {
      await tx.update(user).set({ banned: true, banReason: reason }).where(eq(user.id, id));
      // Bearer tokens are session tokens, so this ends every signed-in app as well.
      await tx.delete(session).where(eq(session.userId, id));
    });
  }

  unban(actorId: string, id: string) {
    return this.mutateUser(actorId, id, "user.unban", {}, async (tx) => {
      await tx
        .update(user)
        .set({ banned: false, banReason: null, banExpires: null })
        .where(eq(user.id, id));
    });
  }

  revokeSessions(actorId: string, id: string) {
    return this.mutateUser(actorId, id, "user.revoke_sessions", {}, async (tx) => {
      const revoked = await tx
        .delete(session)
        .where(eq(session.userId, id))
        .returning({ id: session.id });
      return { count: revoked.length };
    });
  }

  setRole(actorId: string, id: string, role: Role) {
    assertNotSelf(actorId, id);
    return this.mutateUser(actorId, id, "user.role_change", { to: role }, async (tx, target) => {
      await tx.update(user).set({ role }).where(eq(user.id, id));
      return { from: target.role };
    });
  }

  // Sessions, OAuth accounts and devices go with the user through ON DELETE CASCADE.
  deleteUser(actorId: string, id: string) {
    assertNotSelf(actorId, id);
    return this.mutateUser(actorId, id, "user.delete", {}, async (tx, target) => {
      await tx.delete(user).where(eq(user.id, id));
      return { name: target.name, githubLogin: target.githubLogin };
    });
  }

  async revokeDevice(actorId: string, id: string) {
    if (!UUID.test(id)) throw new NotFoundException();
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(device).where(eq(device.id, id)).for("update");
      if (!row) throw new NotFoundException();
      if (row.revokedAt) return;
      await tx
        .update(device)
        .set({ revokedAt: sql`now()` })
        .where(eq(device.id, id));
      await audit(tx, actorId, "device.revoke", "device", id, {
        userId: row.userId,
        name: row.name,
        kind: row.kind,
      });
    });
  }

  private async mutateUser(
    actorId: string,
    id: string,
    action: AuditAction,
    meta: Record<string, unknown>,
    apply: (tx: Tx, target: typeof user.$inferSelect) => Promise<Record<string, unknown> | void>,
  ) {
    await this.database.db.transaction(async (tx) => {
      const [target] = await tx.select().from(user).where(eq(user.id, id)).for("update");
      if (!target) throw new NotFoundException();
      const extra = await apply(tx, target);
      await audit(tx, actorId, action, "user", id, { ...meta, ...extra });
    });
  }
}

function audit(
  tx: Tx,
  actorId: string,
  action: AuditAction,
  targetType: "user" | "device",
  targetId: string,
  meta: Record<string, unknown>,
) {
  return tx.insert(auditLog).values({ actorId, action, targetType, targetId, meta });
}
