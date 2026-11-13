import { and, eq, sql } from "drizzle-orm";
import type { DatabaseService } from "../database/database.service.js";
import { relayUsage } from "../database/tables.schema.js";

const FLUSH_MS = 60_000;

export function usageMonth(at = new Date()) {
  return at.toISOString().slice(0, 7);
}

interface Counter {
  month: string;
  /** Total in the database when last read or written. */
  stored: number;
  pending: number;
}

/**
 * Counts relay bytes per user in memory and adds them to `relay_usage` once a minute. A user over
 * the monthly budget cannot open new channels; open ones finish.
 */
export class RelayUsage {
  private readonly counters = new Map<string, Counter>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly monthlyBytes: number,
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  /** Reads the stored total when a user connects, so a budget survives a restart. */
  async load(userId: string) {
    const month = usageMonth();
    const current = this.counters.get(userId);
    if (current?.month === month) return;
    const [row] = await this.database.db
      .select({ bytes: relayUsage.bytes })
      .from(relayUsage)
      .where(and(eq(relayUsage.userId, userId), eq(relayUsage.month, month)));
    this.counters.set(userId, { month, stored: row?.bytes ?? 0, pending: current?.pending ?? 0 });
  }

  count(userId: string, bytes: number) {
    const month = usageMonth();
    const counter = this.counters.get(userId);
    if (!counter) this.counters.set(userId, { month, stored: 0, pending: bytes });
    else if (counter.month !== month) {
      void this.write(userId, counter.month, counter.pending);
      this.counters.set(userId, { month, stored: 0, pending: bytes });
    } else counter.pending += bytes;
  }

  mayOpen(userId: string) {
    const counter = this.counters.get(userId);
    if (!counter || counter.month !== usageMonth()) return true;
    return counter.stored + counter.pending < this.monthlyBytes;
  }

  async flush() {
    await Promise.all(
      [...this.counters].map(async ([userId, counter]) => {
        if (counter.pending === 0) return;
        const bytes = counter.pending;
        counter.pending = 0;
        const total = await this.write(userId, counter.month, bytes);
        if (total === undefined) counter.pending += bytes;
        else counter.stored = total;
      }),
    );
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }

  private async write(userId: string, month: string, bytes: number) {
    try {
      const [row] = await this.database.db
        .insert(relayUsage)
        .values({ userId, month, bytes })
        .onConflictDoUpdate({
          target: [relayUsage.userId, relayUsage.month],
          set: { bytes: sql`${relayUsage.bytes} + ${bytes}` },
        })
        .returning({ bytes: relayUsage.bytes });
      return row?.bytes;
    } catch {
      return undefined;
    }
  }
}
