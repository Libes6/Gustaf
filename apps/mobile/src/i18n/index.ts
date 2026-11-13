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

function ruPlural(count: number, forms: readonly [string, string, string]): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const form =
    mod10 === 1 && mod100 !== 11
      ? forms[0]
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? forms[1]
        : forms[2];
  return `${count} ${form}`;
}

const RU_WEEKDAYS: Record<string, readonly [plain: string, next: string]> = {
  monday: ["Понедельник", "В следующий понедельник"],
  tuesday: ["Вторник", "В следующий вторник"],
  wednesday: ["Среда", "В следующую среду"],
  thursday: ["Четверг", "В следующий четверг"],
  friday: ["Пятница", "В следующую пятницу"],
  saturday: ["Суббота", "В следующую субботу"],
  sunday: ["Воскресенье", "В следующее воскресенье"],
};

/** A snooze preset's English label (`In 3 hours`, `Next Friday`), rebuilt from its id for Russian. */
export function localizeSnoozePresetLabel(
  preset: { readonly id: string; readonly label: string },
  locale = systemLocale,
): string {
  if (!isRussian(locale)) return preset.label;
  const [kind, value = ""] = preset.id.split(":");
  if (kind === "after") {
    const minutes = Number(value);
    const duration =
      minutes % (24 * 60) === 0
        ? ruPlural(minutes / (24 * 60), ["день", "дня", "дней"])
        : minutes % 60 === 0
          ? ruPlural(minutes / 60, ["час", "часа", "часов"])
          : ruPlural(minutes, ["минуту", "минуты", "минут"]);
    return `Через ${duration}`;
  }
  const translated = t(preset.label, locale);
  if (translated !== preset.label) return translated;
  const weekday = RU_WEEKDAYS[value];
  if (weekday === undefined) return preset.label;
  return preset.label.startsWith("Next ") ? weekday[1] : weekday[0];
}

/** `snoozeWakeLabel`'s compact `5m` / `now` in the interface language. */
export function localizeWakeLabel(label: string, locale = systemLocale): string {
  const match = /^(\d+)([dhm])$/.exec(label);
  return match
    ? formatDurationUnit(match[1]!, match[2] as "d" | "h" | "m", locale)
    : t(label, locale);
}
