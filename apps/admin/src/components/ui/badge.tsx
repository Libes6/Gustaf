import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-transparent px-1.5 font-medium text-xs leading-5",
  {
    defaultVariants: { variant: "secondary" },
    variants: {
      variant: {
        secondary: "bg-accent text-secondary-foreground",
        primary: "bg-primary/10 text-primary dark:bg-primary/20",
        error: "bg-destructive/8 text-destructive-foreground dark:bg-destructive/16",
        success: "bg-success/8 text-success-foreground dark:bg-success/16",
        warning: "bg-warning/8 text-warning-foreground dark:bg-warning/16",
        outline: "border-input text-muted-foreground",
      },
    },
  },
);

export function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
