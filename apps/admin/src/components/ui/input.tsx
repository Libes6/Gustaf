import type * as React from "react";

import { cn } from "../../lib/utils";

const FIELD_CLASS =
  "w-full min-w-0 rounded-lg border border-input bg-background px-3 text-base text-foreground shadow-xs/5 outline-none transition-shadow placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 aria-invalid:border-destructive/36 sm:text-sm dark:bg-input/32";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input data-slot="input" className={cn(FIELD_CLASS, "h-9 sm:h-8", className)} {...props} />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(FIELD_CLASS, "min-h-20 py-2", className)}
      {...props}
    />
  );
}

export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(FIELD_CLASS, "h-9 cursor-pointer pr-8 sm:h-8", className)}
      {...props}
    />
  );
}

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}
