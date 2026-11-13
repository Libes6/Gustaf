import * as NodeFS from "node:fs";
import { desc, eq, gte, sql } from "drizzle-orm";
import type { AppConfig } from "../config.js";
import type { DatabaseService } from "../database/database.service.js";
import { relayDaily, relayUsage, user } from "../database/tables.schema.js";
import { dailySeries, utcDay } from "../relay/relay.daily.js";
import { RELAY_EVENTS } from "../relay/relay.hub.js";
import type { RelayService } from "../relay/relay.service.js";
import { usageMonth } from "../relay/relay.usage.js";
import { fetchCoolifyBackups } from "./coolify.js";
import { fetchReleases } from "./releases.js";
import { TtlCache } from "./ttl-cache.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : "Request failed");

// Relay health, host status and release downloads for /v1/admin; constructed by a factory in app.ts.
export class OpsService {
  private readonly startedAt = new Date();
  private readonly backups;
  private readonly releaseCache;

  constructor(
    private readonly database: DatabaseService,
    private readonly relay: RelayService,
    private readonly build: AppConfig["build"],
    ops: AppConfig["ops"],
  ) {
    const coolify = ops.coolify;
    this.backups = coolify ? new TtlCache(() => fetchCoolifyBackups(coolify), 10 * 60_000) : null;
    this.releaseCache = new TtlCache(
      () => fetchReleases(ops.releasesRepo, ops.githubToken),
      60 * 60_000,
    );
  }

  async relayHealth() {
    const db = this.database.db;
    await this.relay.flush();
    const today = new Date();
    const [daily, top] = await Promise.all([
      db
        .select({ day: relayDaily.day, metric: relayDaily.metric, value: relayDaily.value })
        .from(relayDaily)
        .where(gte(relayDaily.day, utcDay(new Date(today.getTime() - 29 * DAY_MS)))),
      db
        .select({
          userId: relayUsage.userId,
          name: user.name,
          githubLogin: user.githubLogin,
          bytes: relayUsage.bytes,
        })
        .from(relayUsage)
        .innerJoin(user, eq(user.id, relayUsage.userId))
        .where(eq(relayUsage.month, usageMonth(today)))
        .orderBy(desc(relayUsage.bytes))
        .limit(10),
    ]);
    const limit = this.relay.monthlyBytes;
    return {
      live: this.relay.hub.stats(),
      monthlyLimitBytes: limit,
      days: dailySeries(daily, ["bytes", ...RELAY_EVENTS], today),
      topUsers: top.map((row) => ({ ...row, percent: (row.bytes / limit) * 100 })),
    };
  }

  async system() {
    const memory = process.memoryUsage();
    const [database, disk, backups] = await Promise.all([
      this.databaseStats().catch(() => null),
      NodeFS.promises.statfs("/").then(
        (stats) => ({
          totalBytes: stats.blocks * stats.bsize,
          freeBytes: stats.bavail * stats.bsize,
        }),
        () => null,
      ),
      this.backupStatus(),
    ]);
    return {
      build: {
        ...this.build,
        startedAt: this.startedAt,
        uptimeSeconds: Math.round(process.uptime()),
        node: process.version,
      },
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      disk,
      database,
      backups,
    };
  }

  async releases() {
    try {
      const { data, fetchedAt } = await this.releaseCache.get();
      return { status: "ok" as const, fetchedAt, ...data };
    } catch (error) {
      return { status: "error" as const, message: errorText(error) };
    }
  }

  private async databaseStats() {
    const db = this.database.db;
    const [size, tables] = await Promise.all([
      db.execute<{ bytes: string }>(
        sql`select pg_database_size(current_database())::text as bytes`,
      ),
      db.execute<{ schema: string; name: string; bytes: string; rows: string }>(sql`
        select n.nspname as schema, c.relname as name,
          pg_total_relation_size(c.oid)::text as bytes, c.reltuples::bigint::text as rows
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg_toast%'
        order by pg_total_relation_size(c.oid) desc limit 10`),
    ]);
    return {
      sizeBytes: Number(size.rows[0]?.bytes ?? 0),
      tables: tables.rows.map((row) => ({
        name: row.schema === "public" ? row.name : `${row.schema}.${row.name}`,
        bytes: Number(row.bytes),
        // Planner estimate; -1 until the table is first analyzed.
        rows: Number(row.rows) >= 0 ? Number(row.rows) : null,
      })),
    };
  }

  private async backupStatus() {
    if (!this.backups) return { status: "not_configured" as const };
    try {
      const { data, fetchedAt } = await this.backups.get();
      return { status: "ok" as const, fetchedAt, ...data };
    } catch (error) {
      return { status: "error" as const, message: errorText(error) };
    }
  }
}
