const FLUSH_MS = 60_000;

export interface DailyRow {
  day: string;
  metric: string;
  value: number;
}

export function utcDay(at: Date) {
  return at.toISOString().slice(0, 10);
}

/**
 * Relay totals per UTC day (bytes and connection outcomes), summed in memory and added to
 * `relay_daily` once a minute. A failed write keeps its amounts for the next flush.
 */
export class RelayDaily {
  private pending = new Map<string, DailyRow>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly write: (rows: DailyRow[]) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  add(metric: string, value = 1) {
    const day = utcDay(this.now());
    const key = `${day}|${metric}`;
    const row = this.pending.get(key);
    if (row) row.value += value;
    else this.pending.set(key, { day, metric, value });
  }

  async flush() {
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending = new Map();
    try {
      await this.write(rows);
    } catch {
      for (const row of rows) {
        const key = `${row.day}|${row.metric}`;
        const current = this.pending.get(key);
        if (current) current.value += row.value;
        else this.pending.set(key, row);
      }
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}

/** The last `days` UTC days ending today, oldest first, each with every metric (zero when absent). */
export function dailySeries(
  rows: ReadonlyArray<DailyRow>,
  metrics: ReadonlyArray<string>,
  today: Date,
  days = 30,
) {
  const byDay = new Map<string, Record<string, number>>();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = utcDay(new Date(today.getTime() - offset * 24 * 60 * 60 * 1000));
    byDay.set(day, Object.fromEntries(metrics.map((metric) => [metric, 0])));
  }
  for (const row of rows) {
    const values = byDay.get(row.day);
    if (values && row.metric in values) values[row.metric]! += row.value;
  }
  return [...byDay].map(([date, values]) => ({ date, ...values }));
}
