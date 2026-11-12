import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

// Trimmed copy of apps/web/src/components/ui/button.tsx.
const buttonVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,background-color] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 sm:text-sm [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: { size: "default", variant: "default" },
    variants: {
      size: {
        default: "h-9 px-3 sm:h-8",
        sm: "h-8 gap-1.5 px-2.5 sm:h-7",
        lg: "h-10 px-4 sm:h-9",
        icon: "size-9 sm:size-8",
      },
      variant: {
        default:
          "border-primary bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 active:shadow-none",
        destructive:
          "border-destructive bg-destructive text-white shadow-xs hover:bg-destructive/90 active:shadow-none",
        "destructive-outline":
          "border-input bg-popover text-destructive-foreground shadow-xs/5 hover:border-destructive/32 hover:bg-destructive/4 dark:bg-input/32",
        outline:
          "border-input bg-popover text-foreground shadow-xs/5 hover:bg-accent dark:bg-input/32 dark:hover:bg-input/64",
        ghost: "border-transparent text-foreground hover:bg-accent",
      },
    },
  },
);

interface ButtonProps
  extends useRender.ComponentProps<"button">, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = {
    className: cn(buttonVariants({ size, variant }), className),
    "data-slot": "button",
    type: render ? undefined : ("button" as const),
  };
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
