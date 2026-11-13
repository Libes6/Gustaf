import { type ApiErrorKind, isApiError } from "../api/client";
import { strings } from "../strings";

const dateTime = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" });
const shortDay = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const count = new Intl.NumberFormat("en-US");
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

export function formatCount(value: number): string {
  return count.format(value);
}

/** Tokens of the measured turns; with no measured turn the count is unknown, not zero. */
export function formatTokens(tokens: number, measuredTurns: number): string {
  return measuredTurns === 0 ? strings.aiUsage.unknown : count.format(tokens);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return strings.common.never;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateTime.format(date);
}

/** A `YYYY-MM-DD` day from the API, read as a UTC calendar day. */
export function formatDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : shortDay.format(date);
}

export function formatRelative(iso: string | null | undefined, now: number): string {
  if (!iso) return strings.common.never;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.round((then - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return relative.format(0, "minute");
}

export function shortCommit(commit: string): string {
  return /^[0-9a-f]{12,}$/i.test(commit) ? commit.slice(0, 7) : commit;
}

export function auditActionLabel(action: string): string {
  return strings.audit.actions[action] ?? action;
}

const ERROR_MESSAGES: Record<ApiErrorKind, string> = {
  network: strings.errors.network,
  unauthorized: strings.errors.unauthorized,
  forbidden: strings.errors.forbidden,
  "not-found": strings.errors.notFound,
  "rate-limited": strings.errors.rateLimited,
  server: strings.errors.server,
  "bad-request": strings.errors.server,
};

/** The API's own message for a 400, a generic one for everything else. */
export function errorMessage(error: unknown): string {
  if (!isApiError(error)) return strings.errors.title;
  if (error.kind === "bad-request" && error.message) return error.message;
  return ERROR_MESSAGES[error.kind];
}

export function formatMeta(meta: unknown): string {
  return JSON.stringify(meta, null, 2) ?? "null";
}

export function hasMeta(meta: unknown): boolean {
  if (meta === null || meta === undefined) return false;
  if (typeof meta === "object") return Object.keys(meta).length > 0;
  return true;
}
