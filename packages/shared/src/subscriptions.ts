import type { Subscription, SubscriptionPeriod } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

type ChargeSchedule = Pick<Subscription, "period" | "anchorDate" | "status">;

function parseDay(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return { year, month, day };
}

function formatDay(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// Proleptic Gregorian day numbers (Hinnant's days_from_civil), free of time zones and clocks.
function epochDay(date: string): number {
  const { year, month, day } = parseDay(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

function fromEpochDay(value: number): string {
  const z = value + 719_468;
  const era = Math.floor(z / 146_097);
  const dayOfEra = z - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return formatDay(yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day);
}

/** Keeps the anchor's day of month, clamped to shorter months (Jan 31 + 1 month is Feb 28). */
function addMonths(date: string, months: number): string {
  const { year, month, day } = parseDay(date);
  const index = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return formatDay(nextYear, nextMonth, Math.min(day, daysInMonth(nextYear, nextMonth)));
}

function chargeAt(anchorDate: string, period: SubscriptionPeriod, index: number): string {
  switch (period.unit) {
    case "day":
      return fromEpochDay(epochDay(anchorDate) + index * period.count);
    case "week":
      return fromEpochDay(epochDay(anchorDate) + index * period.count * 7);
    case "month":
      return addMonths(anchorDate, index * period.count);
    case "year":
      return addMonths(anchorDate, index * period.count * 12);
  }
}

/** The calendar day, `YYYY-MM-DD`, at `millis` in this machine's time zone. */
export function localCalendarDate(millis: number): string {
  const instant = Option.getOrElse(
    DateTime.makeZoned(millis, { timeZone: DateTime.zoneMakeLocal() }),
    () => DateTime.makeUnsafe(millis),
  );
  const { year, month, day } = DateTime.toParts(instant);
  return formatDay(year, month, day);
}

/** The first charge on or after `today`, or null for a cancelled or past one-time subscription. */
export function nextChargeDate(subscription: ChargeSchedule, today: string): string | null {
  if (subscription.status._tag === "Cancelled") return null;
  const { period, anchorDate } = subscription;
  if (period === null) return anchorDate >= today ? anchorDate : null;
  if (anchorDate >= today) return anchorDate;
  let index: number;
  if (period.unit === "day" || period.unit === "week") {
    const step = period.count * (period.unit === "week" ? 7 : 1);
    index = Math.ceil((epochDay(today) - epochDay(anchorDate)) / step);
  } else {
    const anchor = parseDay(anchorDate);
    const now = parseDay(today);
    const months = (now.year - anchor.year) * 12 + (now.month - anchor.month);
    index = Math.floor(months / (period.count * (period.unit === "year" ? 12 : 1)));
  }
  let charge = chargeAt(anchorDate, period, Math.max(0, index));
  while (charge < today) charge = chargeAt(anchorDate, period, ++index);
  return charge;
}

export function daysUntil(date: string, today: string): number {
  return epochDay(date) - epochDay(today);
}

/** Whether the next charge falls inside the subscription's reminder window. */
export function isChargeReminderDue(
  subscription: ChargeSchedule & Pick<Subscription, "reminderDaysBefore">,
  today: string,
): boolean {
  if (subscription.reminderDaysBefore === null) return false;
  const next = nextChargeDate(subscription, today);
  return next !== null && daysUntil(next, today) <= subscription.reminderDaysBefore;
}

const CHARGES_PER_YEAR = { day: 365, week: 52, month: 12, year: 1 } as const;

/** Recurring cost per year; one-time and cancelled subscriptions cost nothing going forward. */
export function yearlyCost(subscription: Pick<Subscription, "amount" | "period" | "status">) {
  if (subscription.period === null || subscription.status._tag === "Cancelled") return 0;
  return (
    (subscription.amount * CHARGES_PER_YEAR[subscription.period.unit]) / subscription.period.count
  );
}

export function monthlyCost(subscription: Pick<Subscription, "amount" | "period" | "status">) {
  return yearlyCost(subscription) / 12;
}

export interface SubscriptionCurrencyTotal {
  readonly currency: string;
  readonly monthly: number;
  readonly yearly: number;
}

/** Totals per currency; amounts in different currencies are never added together. */
export function subscriptionTotalsByCurrency(
  subscriptions: ReadonlyArray<Pick<Subscription, "amount" | "currency" | "period" | "status">>,
): ReadonlyArray<SubscriptionCurrencyTotal> {
  const yearly = new Map<string, number>();
  for (const subscription of subscriptions) {
    const cost = yearlyCost(subscription);
    if (cost === 0) continue;
    yearly.set(subscription.currency, (yearly.get(subscription.currency) ?? 0) + cost);
  }
  return [...yearly]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, total]) => ({ currency, monthly: total / 12, yearly: total }));
}
