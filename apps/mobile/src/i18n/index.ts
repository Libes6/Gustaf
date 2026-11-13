import ru from "./ru.json";

const systemLocale = Intl.DateTimeFormat().resolvedOptions().locale;

function isRussian(locale: string): boolean {
  return locale.toLowerCase().startsWith("ru");
}

// Translate interface copy only at its call site; messages, code and names stay untouched.
export function t(text: string, locale = systemLocale): string {
  return isRussian(locale) ? (ru[text as keyof typeof ru] ?? text) : text;
}

const DURATION_UNITS = {
  en: { d: "d", h: "h", m: "m", s: "s", gap: "" },
  ru: { d: "д", h: "ч", m: "мин", s: "с", gap: " " },
} as const;

/** One compact duration part: `5m` / `5 мин`. */
export function formatDurationUnit(
  value: number | string,
  unit: "d" | "h" | "m" | "s",
  locale = systemLocale,
): string {
  const units = DURATION_UNITS[isRussian(locale) ? "ru" : "en"];
  return `${value}${units.gap}${units[unit]}`;
}

/** Elapsed time for live timers: `4s`, `1m 05s`, `1h 02m` (ru: `4 с`, `1 мин 05 с`, `1 ч 02 мин`). */
export function formatElapsed(elapsedMs: number, locale = systemLocale): string {
  const unit = (value: number | string, name: "h" | "m" | "s") =>
    formatDurationUnit(value, name, locale);
  const totalSeconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1_000)) : 0;
  if (totalSeconds < 60) return unit(totalSeconds, "s");
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${unit(totalMinutes, "m")} ${unit(String(totalSeconds % 60).padStart(2, "0"), "s")}`;
  }
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${unit(Math.floor(totalMinutes / 60), "h")} ${unit(minutes, "m")}`;
}
