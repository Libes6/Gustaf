import { HttpException, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { decodeCursor, toPage } from "../admin/admin-rules.js";
import { DatabaseService } from "../database/database.service.js";
import { auditLog, bugReport, device, user } from "../database/tables.schema.js";
import {
  isReportId,
  REPORT_RATE_LIMIT,
  type readReportInput,
  type readReportUpdate,
  type ReportStatus,
} from "./report-rules.js";

type Page = { limit: number; cursor: string | undefined };

const PREVIEW_CHARS = 200;

const summaryColumns = {
  id: bugReport.id,
  userId: bugReport.userId,
  userName: user.name,
  userEmail: user.email,
  client: bugReport.client,
  appVersion: bugReport.appVersion,
  platform: bugReport.platform,
  preview: sql<string>`left(${bugReport.message}, ${PREVIEW_CHARS})`,
  hasLogs: sql<boolean>`${bugReport.logs} is not null`,
  status: bugReport.status,
  createdAt: bugReport.createdAt,
};

@Injectable()
export class ReportsService {
  constructor(private readonly database: DatabaseService) {}

  async create(userId: string, input: ReturnType<typeof readReportInput>) {
    const db = this.database.db;
    const since = new Date(Date.now() - REPORT_RATE_LIMIT.windowMs);
    const [recent] = await db
      .select({ count: count() })
      .from(bugReport)
      .where(and(eq(bugReport.userId, userId), gt(bugReport.createdAt, since)));
    if ((recent?.count ?? 0) >= REPORT_RATE_LIMIT.reports) {
      throw new HttpException({ error: "rate_limited" }, 429);
    }
    // A device id that is not this user's live device is dropped rather than trusted.
    let deviceId: string | null = null;
    if (input.deviceId) {
      const [owned] = await db
        .select({ id: device.id })
        .from(device)
        .where(
          and(eq(device.id, input.deviceId), eq(device.userId, userId), isNull(device.revokedAt)),
        );
      deviceId = owned?.id ?? null;
    }
    const [row] = await db
      .insert(bugReport)
      .values({ ...input, userId, deviceId })
      .returning({ id: bugReport.id, createdAt: bugReport.createdAt });
    return { report: row! };
  }

  async list(status: ReportStatus | undefined, page: Page) {
    const cursor = page.cursor ? decodeCursor(page.cursor, 2) : undefined;
    const rows = await this.database.db
      .select({ ...summaryColumns, cursorAt: sql<string>`${bugReport.createdAt}::text` })
      .from(bugReport)
      .innerJoin(user, eq(user.id, bugReport.userId))
      .where(
        and(
          status ? eq(bugReport.status, status) : undefined,
          cursor
            ? sql`(${bugReport.createdAt}, ${bugReport.id}) < (${String(cursor[0])}::timestamptz, ${String(cursor[1])}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(bugReport.createdAt), desc(bugReport.id))
      .limit(page.limit + 1);
    return toPage(
      rows,
      page.limit,
      ({ cursorAt: _cursorAt, ...row }) => row,
      (row) => [row.cursorAt, row.id],
    );
  }

  async counts() {
    const rows = await this.database.db
      .select({ status: bugReport.status, count: count() })
      .from(bugReport)
      .groupBy(bugReport.status);
    const counts = { new: 0, seen: 0, closed: 0 };
    for (const row of rows) counts[row.status] = row.count;
    return counts;
  }

  async get(id: string) {
    if (!isReportId(id)) throw new NotFoundException();
    const [row] = await this.database.db
      .select({
        ...summaryColumns,
        message: bugReport.message,
        logs: bugReport.logs,
        adminNote: bugReport.adminNote,
        deviceId: bugReport.deviceId,
        deviceName: device.name,
        updatedAt: bugReport.updatedAt,
      })
      .from(bugReport)
      .innerJoin(user, eq(user.id, bugReport.userId))
      .leftJoin(device, eq(device.id, bugReport.deviceId))
      .where(eq(bugReport.id, id));
    if (!row) throw new NotFoundException();
    const { preview: _preview, ...report } = row;
    return report;
  }

  async update(actorId: string, id: string, change: ReturnType<typeof readReportUpdate>) {
    if (!isReportId(id)) throw new NotFoundException();
    await this.database.db.transaction(async (tx) => {
      const [row] = await tx.select().from(bugReport).where(eq(bugReport.id, id)).for("update");
      if (!row) throw new NotFoundException();
      const status = change.status ?? row.status;
      const note = change.note === undefined ? row.adminNote : change.note;
      if (status === row.status && note === row.adminNote) return;
      await tx
        .update(bugReport)
        .set({ status, adminNote: note, updatedAt: sql`now()` })
        .where(eq(bugReport.id, id));
      // The note itself stays out of the audit trail; whether it changed is enough.
      await tx.insert(auditLog).values({
        actorId,
        action: "report.update",
        targetType: "report",
        targetId: id,
        meta: {
          ...(status !== row.status ? { from: row.status, to: status } : {}),
          ...(note !== row.adminNote ? { noteChanged: true } : {}),
        },
      });
    });
  }
}
