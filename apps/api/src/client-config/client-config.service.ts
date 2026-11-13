import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import {
  announcement,
  auditLog,
  featureFlag,
  minimumVersion,
  user,
} from "../database/tables.schema.js";
import {
  type ClientKind,
  type ClientQuery,
  readAnnouncementInput,
  readFlagInput,
  readMinimumVersionInput,
  resolveClientConfig,
} from "./client-config-rules.js";

type AnnouncementInput = ReturnType<typeof readAnnouncementInput>;
type FlagInput = ReturnType<typeof readFlagInput>;
type MinimumVersionInput = ReturnType<typeof readMinimumVersionInput>;
type Tx = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

type AuditAction =
  | "announcement.create"
  | "announcement.update"
  | "announcement.delete"
  | "minimum_version.set"
  | "minimum_version.clear"
  | "feature_flag.create"
  | "feature_flag.update"
  | "feature_flag.delete";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Every client polls this; a short in-process snapshot keeps it off the database. Admin writes
// on this process drop it at once, other replicas within the TTL.
const SNAPSHOT_TTL_MS = 30_000;

@Injectable()
export class ClientConfigService {
  private snapshot: { at: number; rows: Promise<Snapshot> } | undefined;

  constructor(private readonly database: DatabaseService) {}

  async resolve(client: ClientQuery, login: string | null) {
    return resolveClientConfig(await this.rows(), client, login, new Date());
  }

  /** Whether any flag depends on who is asking; otherwise credentials need not be checked. */
  async hasListedFlags() {
    return (await this.rows()).flags.some((flag) => flag.mode === "listed");
  }

  async githubLogin(userId: string) {
    const [row] = await this.database.db
      .select({ githubLogin: user.githubLogin, banned: user.banned })
      .from(user)
      .where(eq(user.id, userId));
    return row && !row.banned ? row.githubLogin : null;
  }

  private rows() {
    const now = Date.now();
    if (!this.snapshot || now - this.snapshot.at > SNAPSHOT_TTL_MS) {
      const rows = loadSnapshot(this.database.db);
      this.snapshot = { at: now, rows };
      rows.catch(() => {
        if (this.snapshot?.rows === rows) this.snapshot = undefined;
      });
    }
    return this.snapshot.rows;
  }

  // Admin

  listAnnouncements() {
    return this.database.db
      .select()
      .from(announcement)
      .orderBy(desc(announcement.createdAt))
      .then((items) => ({ items }));
  }

  async createAnnouncement(actorId: string, input: AnnouncementInput) {
    return this.write(async (tx) => {
      const [row] = await tx.insert(announcement).values(input).returning();
      await audit(tx, actorId, "announcement.create", "announcement", row!.id, summary(input));
      return row!;
    });
  }

  async updateAnnouncement(actorId: string, id: string, input: AnnouncementInput) {
    if (!UUID.test(id)) throw new NotFoundException();
    return this.write(async (tx) => {
      const [row] = await tx
        .update(announcement)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(announcement.id, id))
        .returning();
      if (!row) throw new NotFoundException();
      await audit(tx, actorId, "announcement.update", "announcement", id, summary(input));
      return row;
    });
  }

  async deleteAnnouncement(actorId: string, id: string) {
    if (!UUID.test(id)) throw new NotFoundException();
    await this.write(async (tx) => {
      const [row] = await tx.delete(announcement).where(eq(announcement.id, id)).returning();
      if (!row) throw new NotFoundException();
      await audit(tx, actorId, "announcement.delete", "announcement", id, summary(row));
    });
  }

  listMinimumVersions() {
    return this.database.db
      .select()
      .from(minimumVersion)
      .then((items) => ({ items }));
  }

  async setMinimumVersion(actorId: string, kind: ClientKind, input: MinimumVersionInput) {
    return this.write(async (tx) => {
      const [row] = await tx
        .insert(minimumVersion)
        .values({ kind, ...input })
        .onConflictDoUpdate({
          target: minimumVersion.kind,
          set: { ...input, updatedAt: sql`now()` },
        })
        .returning();
      await audit(tx, actorId, "minimum_version.set", "minimum_version", kind, { ...input });
      return row!;
    });
  }

  async clearMinimumVersion(actorId: string, kind: ClientKind) {
    await this.write(async (tx) => {
      const [row] = await tx
        .delete(minimumVersion)
        .where(eq(minimumVersion.kind, kind))
        .returning();
      if (!row) return;
      await audit(tx, actorId, "minimum_version.clear", "minimum_version", kind, {
        version: row.version,
      });
    });
  }

  listFlags() {
    return this.database.db
      .select()
      .from(featureFlag)
      .orderBy(featureFlag.key)
      .then((items) => ({ items }));
  }

  async createFlag(actorId: string, key: string, input: FlagInput) {
    return this.write(async (tx) => {
      const [row] = await tx
        .insert(featureFlag)
        .values({ key, ...input })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new ConflictException(`Flag ${key} already exists`);
      await audit(tx, actorId, "feature_flag.create", "feature_flag", key, flagMeta(input));
      return row;
    });
  }

  async updateFlag(actorId: string, key: string, input: FlagInput) {
    return this.write(async (tx) => {
      const [before] = await tx
        .select()
        .from(featureFlag)
        .where(eq(featureFlag.key, key))
        .for("update");
      if (!before) throw new NotFoundException();
      const [row] = await tx
        .update(featureFlag)
        .set({ ...input, updatedAt: sql`now()` })
        .where(eq(featureFlag.key, key))
        .returning();
      await audit(tx, actorId, "feature_flag.update", "feature_flag", key, {
        ...flagMeta(input),
        from: before.mode,
      });
      return row!;
    });
  }

  async deleteFlag(actorId: string, key: string) {
    await this.write(async (tx) => {
      const [row] = await tx.delete(featureFlag).where(eq(featureFlag.key, key)).returning();
      if (!row) throw new NotFoundException();
      await audit(tx, actorId, "feature_flag.delete", "feature_flag", key, { mode: row.mode });
    });
  }

  private async write<T>(apply: (tx: Tx) => Promise<T>) {
    try {
      return await this.database.db.transaction(apply);
    } finally {
      this.snapshot = undefined;
    }
  }
}

async function loadSnapshot(db: DatabaseService["db"]) {
  const [announcements, minimumVersions, flags] = await Promise.all([
    db.select().from(announcement).where(eq(announcement.active, true)),
    db.select().from(minimumVersion),
    db.select().from(featureFlag),
  ]);
  return { announcements, minimumVersions, flags };
}

type Snapshot = Awaited<ReturnType<typeof loadSnapshot>>;

const summary = (row: { textEn: string; level: string; target: string; active: boolean }) => ({
  text: row.textEn.slice(0, 120),
  level: row.level,
  target: row.target,
  active: row.active,
});

const flagMeta = (input: FlagInput) => ({ mode: input.mode, logins: input.logins.length });

function audit(
  tx: Tx,
  actorId: string,
  action: AuditAction,
  targetType: "announcement" | "minimum_version" | "feature_flag",
  targetId: string,
  meta: Record<string, unknown>,
) {
  return tx.insert(auditLog).values({ actorId, action, targetType, targetId, meta });
}
