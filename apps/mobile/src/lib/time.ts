import { formatDurationUnit } from "../i18n";

export function relativeTime(input: string, nowMs: number = Date.now(), locale?: string): string {
  const lessThanMinute = `<${formatDurationUnit(1, "m", locale)}`;
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return lessThanMinute;
  }

  const deltaSeconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (deltaSeconds < 60) return lessThanMinute;

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return formatDurationUnit(deltaMinutes, "m", locale);

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return formatDurationUnit(deltaHours, "h", locale);

  const deltaDays = Math.floor(deltaHours / 24);
  return formatDurationUnit(deltaDays, "d", locale);
}

/** Milliseconds until the relative-time label next changes. */
export function msUntilRelativeTimeChange(
  input: string,
  nowMs: number = Date.now(),
): number | null {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) return null;
  const elapsedMs = Math.max(0, nowMs - timestamp);
  const unitMs = elapsedMs < 3_600_000 ? 60_000 : elapsedMs < 86_400_000 ? 3_600_000 : 86_400_000;
  const nextChangeMs = timestamp + (Math.floor(elapsedMs / unitMs) + 1) * unitMs;
  // Far-future timestamps must not overflow setTimeout's signed 32-bit delay.
  return Math.min(nextChangeMs - nowMs, 86_400_000);
}
