import { formatDay } from "../lib/format";
import { cn } from "../lib/utils";

/** One bar per UTC day, scaled to the largest value. Plain SVG, no animation. */
export function DailyBars({
  days,
  format,
  summary,
  empty,
}: {
  readonly days: ReadonlyArray<{ readonly date: string; readonly value: number }>;
  readonly format: (value: number) => string;
  readonly summary: string;
  readonly empty: string;
}) {
  const max = Math.max(0, ...days.map((day) => day.value));
  if (days.length === 0 || max === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  const barWidth = 100 / days.length;
  return (
    <figure className="mt-3">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
        className="h-36 w-full text-primary"
      >
        {days.map((day, index) => {
          const height = Math.max((day.value / max) * 38, day.value > 0 ? 0.8 : 0.3);
          return (
            <rect
              key={day.date}
              x={index * barWidth + barWidth * 0.15}
              y={40 - height}
              width={barWidth * 0.7}
              height={height}
              rx={0.4}
              className={day.value > 0 ? "fill-current" : "fill-border"}
            >
              <title>{`${formatDay(day.date)}: ${format(day.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>{formatDay(days[0]!.date)}</span>
        <span className="text-center">{summary}</span>
        <span>{formatDay(days.at(-1)!.date)}</span>
      </figcaption>
    </figure>
  );
}

/** A horizontal fill from 0 to 100 %, warning from 80 % and error from 95 %. */
export function Meter({ percent, label }: { readonly percent: number; readonly label: string }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-accent"
    >
      <div
        className={cn(
          "h-full rounded-full",
          clamped >= 95 ? "bg-destructive" : clamped >= 80 ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}
