/** Unit keys of the i18n dictionaries; each value is "{n} s", "{n} min" or "{n} h" in the locale's wording. */
export type DurationKey = "durationSeconds" | "durationMinutes" | "durationHours";
/** The `t` of `useT()` (or any function that fills `{n}` into the unit strings). */
export type DurationT = (key: DurationKey, vars: { n: number | string }) => string;

/**
 * Elapsed time for people: `45 s`, `2 min 42 s`, `1 h 30 min` (seconds are dropped from the hour mark). Negative and
 * non-finite input counts as 0. With `tenths`, the part under a minute keeps one decimal (`12.3 s`, truncated, never
 * rounded up to `60.0 s`); from a minute on it is the same as without. With `seconds`, the hour form keeps
 * them (`1 h 0 min 12 s`) so a running timer visibly ticks.
 */
export function formatDuration(seconds: number, t: DurationT, opts: { tenths?: boolean; seconds?: boolean } = {}): string {
  const total = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (total < 60) {
    const n = opts.tenths ? (Math.floor(total * 10 + 1e-9) / 10).toFixed(1) : Math.floor(total);
    return t("durationSeconds", { n });
  }
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${t("durationHours", { n: h })} ${t("durationMinutes", { n: m })}${opts.seconds ? ` ${t("durationSeconds", { n: s % 60 })}` : ""}`;
  return `${t("durationMinutes", { n: m })} ${t("durationSeconds", { n: s % 60 })}`;
}

export const formatDurationMs = (ms: number, t: DurationT, opts?: { tenths?: boolean; seconds?: boolean }) => formatDuration(ms / 1000, t, opts);
