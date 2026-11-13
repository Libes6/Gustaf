import { Injectable } from "@nestjs/common";
import { and, countDistinct, desc, eq, gte, lt, sql } from "drizzle-orm";
import { DatabaseService } from "../database/database.service.js";
import { aiUsageDaily, aiUsageReport, user } from "../database/tables.schema.js";
import { periodStart, type readUsageReport, type UsagePeriod } from "./usage-rules.js";

// Batch ids only need to outlive a host's retries, which stop when it quits.
const REPORT_RETENTION = sql`interval '30 days'`;
const SUMMARY_ROWS = 100;

const sums = {
  turns: sql<number>`coalesce(sum(${aiUsageDaily.turns}), 0)`.mapWith(Number),
  measuredTurns: sql<number>`coalesce(sum(${aiUsageDaily.measuredTurns}), 0)`.mapWith(Number),
  inputTokens: sql<number>`coalesce(sum(${aiUsageDaily.inputTokens}), 0)`.mapWith(Number),
  outputTokens: sql<number>`coalesce(sum(${aiUsageDaily.outputTokens}), 0)`.mapWith(Number),
};

@Injectable()
export class UsageService {
  constructor(private readonly database: DatabaseService) {}

  /** Adds a batch to the owner's daily totals once; a repeated batch id changes nothing. */
  async record(
    owner: { deviceId: string; userId: string },
    report: ReturnType<typeof readUsageReport>,
  ) {
    const accepted = await this.database.db.transaction(async (tx) => {
      const [fresh] = await tx
        .insert(aiUsageReport)
        .values({ deviceId: owner.deviceId, batchId: report.batchId })
        .onConflictDoNothing()
        .returning({ batchId: aiUsageReport.batchId });
      if (!fresh) return false;
      await tx
        .insert(aiUsageDaily)
        .values(report.buckets.map((bucket) => ({ userId: owner.userId, ...bucket })))
        .onConflictDoUpdate({
          target: [
            aiUsageDaily.userId,
            aiUsageDaily.day,
            aiUsageDaily.provider,
            aiUsageDaily.model,
          ],
          set: {
            turns: sql`${aiUsageDaily.turns} + excluded.turns`,
            measuredTurns: sql`${aiUsageDaily.measuredTurns} + excluded.measured_turns`,
            inputTokens: sql`${aiUsageDaily.inputTokens} + excluded.input_tokens`,
            outputTokens: sql`${aiUsageDaily.outputTokens} + excluded.output_tokens`,
          },
        });
      return true;
    });
    if (accepted) {
      await this.database.db
        .delete(aiUsageReport)
        .where(lt(aiUsageReport.receivedAt, sql`now() - ${REPORT_RETENTION}`))
        .catch(() => undefined);
    }
    return { duplicate: !accepted };
  }

  /** Totals since the period's first UTC day, for everyone or for one user. */
  async summary(days: UsagePeriod, userId?: string) {
    const db = this.database.db;
    const from = periodStart(days);
    const where = and(
      gte(aiUsageDaily.day, from),
      userId === undefined ? undefined : eq(aiUsageDaily.userId, userId),
    );
    const users = countDistinct(aiUsageDaily.userId);
    const [[totals], byModel, byUser] = await Promise.all([
      db
        .select({ ...sums, users })
        .from(aiUsageDaily)
        .where(where),
      db
        .select({ provider: aiUsageDaily.provider, model: aiUsageDaily.model, ...sums, users })
        .from(aiUsageDaily)
        .where(where)
        .groupBy(aiUsageDaily.provider, aiUsageDaily.model)
        .orderBy(desc(sums.turns), aiUsageDaily.provider, aiUsageDaily.model)
        .limit(SUMMARY_ROWS),
      db
        .select({ userId: aiUsageDaily.userId, name: user.name, email: user.email, ...sums })
        .from(aiUsageDaily)
        .innerJoin(user, eq(user.id, aiUsageDaily.userId))
        .where(where)
        .groupBy(aiUsageDaily.userId, user.name, user.email)
        .orderBy(desc(sums.turns), aiUsageDaily.userId)
        .limit(SUMMARY_ROWS),
    ]);
    return {
      days,
      from,
      totals: totals!,
      byModel: byModel.map((row) => ({ ...row, model: row.model || null })),
      byUser,
    };
  }
}
