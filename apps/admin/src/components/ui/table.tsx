import type * as React from "react";

import { cn } from "../../lib/utils";

// Trimmed copy of apps/web/src/components/ui/table.tsx.
export function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table data-slot="table" className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader(props: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className="bg-muted [&_tr]:border-b [&_tr]:hover:bg-transparent"
      {...props}
    />
  );
}

export function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className="[&_tr:last-child]:border-0" {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b transition-colors hover:bg-muted/70", className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-10 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:ps-5 last:pe-5",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "h-12 px-3 py-2.5 align-middle whitespace-nowrap first:ps-5 last:pe-5",
        className,
      )}
      {...props}
    />
  );
}
