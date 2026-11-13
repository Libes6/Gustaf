import type * as React from "react";

import { cn } from "../../lib/utils";

export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      data-slot="card"
      className={cn("rounded-xl border bg-card p-4 text-card-foreground shadow-xs/5", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="card-title"
      className={cn("text-sm font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}
