import { BadRequestException } from "@nestjs/common";

// What a computer may report: counts per UTC day, provider and model, never content.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// A host keeps unsent counts only while it runs; older days would be a replay or a broken clock.
const MAX_AGE_DAYS = 31;
const MAX_BUCKETS = 500;
const MAX_TURNS = 1_000_000;
const MAX_TOKENS = 1e13;

export const USAGE_PERIODS = [1, 7, 30, 90] as const;
export type UsagePeriod = (typeof USAGE_PERIODS)[number];

export interface UsageBucket {
  day: string;
  provider: string;
  /** '' when the computer could not name a catalog model. */
  model: string;
  turns: number;
  measuredTurns: number;
  inputTokens: number;
  outputTokens: number;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function count(value: unknown, field: string, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new BadRequestException(`${field} must be a whole number between 0 and ${max}`);
  }
  return value;
}

function readBucket(value: unknown, oldest: string, newest: string): UsageBucket {
  const bucket = (value ?? {}) as Record<string, unknown>;
  const { day, provider, model } = bucket;
  const parsedDay = typeof day === "string" ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (
    typeof day !== "string" ||
    !DAY.test(day) ||
    !Number.isFinite(parsedDay) ||
    utcDay(parsedDay) !== day
  ) {
    throw new BadRequestException("day must be a YYYY-MM-DD date");
  }
  if (day < oldest || day > newest) throw new BadRequestException("day is out of range");
  if (typeof provider !== "string" || !PROVIDER.test(provider)) {
    throw new BadRequestException("provider is invalid");
  }
  if (model !== null && (typeof model !== "string" || !MODEL.test(model))) {
    throw new BadRequestException("model is invalid");
  }
  const turns = count(bucket.turns, "turns", MAX_TURNS);
  const measuredTurns = count(bucket.measuredTurns, "measuredTurns", turns);
  const inputTokens = count(bucket.inputTokens, "inputTokens", MAX_TOKENS);
  const outputTokens = count(bucket.outputTokens, "outputTokens", MAX_TOKENS);
  if (turns === 0) throw new BadRequestException("turns must be at least 1");
  // Tokens of unmeasured turns are unknown, not zero, so they cannot appear without a measured turn.
  if (measuredTurns === 0 && (inputTokens > 0 || outputTokens > 0)) {
    throw new BadRequestException("tokens need at least one measured turn");
  }
  return { day, provider, model: model ?? "", turns, measuredTurns, inputTokens, outputTokens };
}

export function readUsageReport(body: unknown, now = Date.now()) {
  const { batchId, buckets } = (body ?? {}) as Record<string, unknown>;
  if (typeof batchId !== "string" || !UUID.test(batchId)) {
    throw new BadRequestException("batchId must be a UUID");
  }
  if (!Array.isArray(buckets) || buckets.length < 1 || buckets.length > MAX_BUCKETS) {
    throw new BadRequestException(`buckets must hold 1-${MAX_BUCKETS} entries`);
  }
  const oldest = utcDay(now - MAX_AGE_DAYS * DAY_MS);
  const newest = utcDay(now + DAY_MS);
  const read = buckets.map((bucket) => readBucket(bucket, oldest, newest));
  const keys = new Set(read.map((bucket) => `${bucket.day}\n${bucket.provider}\n${bucket.model}`));
  if (keys.size !== read.length) {
    throw new BadRequestException("buckets must not repeat a day, provider and model");
  }
  return { batchId: batchId.toLowerCase(), buckets: read };
}

export function readUsagePeriod(value: unknown): UsagePeriod {
  if (value === undefined || value === "") return 30;
  const days = typeof value === "string" && /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!USAGE_PERIODS.includes(days as UsagePeriod)) {
    throw new BadRequestException(`days must be one of ${USAGE_PERIODS.join(", ")}`);
  }
  return days as UsagePeriod;
}

/** The first UTC day of a period that ends today. */
export function periodStart(days: UsagePeriod, now = Date.now()) {
  return utcDay(now - (days - 1) * DAY_MS);
}
