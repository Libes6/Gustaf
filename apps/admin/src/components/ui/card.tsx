import type * as React from "react";

import { cn } from "../../lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn(
        "overflow-hidden rounded-xl border bg-card p-5 text-card-foreground shadow-xs/4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Top row of a flush (`p-0`) card: optional heading and hint on the start side, then controls.
 * Without a title it is a toolbar for filters above a table.
 */
export function CardHeader({
  title,
  description,
  children,
}: {
  readonly title?: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly children?: React.ReactNode;
}) {
  return (
    <header
      data-slot="card-header"
      className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-3"
    >
      {title ? (
        <div className="me-auto min-w-0">
          <CardTitle>{title}</CardTitle>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </header>
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("text-[0.9375rem] font-semibold leading-6 text-card-foreground", className)}
      {...props}
    />
  );
}
