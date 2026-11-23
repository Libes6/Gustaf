import { AlertDialog } from "@base-ui/react/alert-dialog";
import type * as React from "react";

import { strings } from "../../strings";
import { Button } from "./button";

interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly destructive?: boolean;
  readonly pending?: boolean;
  readonly confirmDisabled?: boolean;
  readonly onConfirm: () => void;
  readonly children?: React.ReactNode;
}

/** A confirmation step for an admin action. Focus is trapped and Escape cancels. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending = false,
  confirmDisabled = false,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/32 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid grid-rows-[1fr_auto_1fr] justify-items-center p-4 max-sm:grid-rows-[1fr_auto] max-sm:p-0">
          <AlertDialog.Popup className="row-start-2 flex w-full max-w-lg flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 max-sm:rounded-b-none">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!pending && !confirmDisabled) onConfirm();
              }}
            >
              <div className="flex flex-col gap-2 p-6">
                <AlertDialog.Title className="wrap-anywhere text-lg font-semibold leading-snug">
                  {title}
                </AlertDialog.Title>
                <AlertDialog.Description className="text-sm text-muted-foreground">
                  {description}
                </AlertDialog.Description>
                {children}
              </div>
              <div className="flex flex-col-reverse gap-2 rounded-b-2xl border-t bg-muted px-6 py-4 sm:flex-row sm:justify-end">
                <AlertDialog.Close
                  disabled={pending}
                  render={<Button variant="outline">{strings.common.cancel}</Button>}
                />
                <Button
                  type="submit"
                  variant={destructive ? "destructive" : "default"}
                  disabled={pending || confirmDisabled}
                  aria-busy={pending}
                >
                  {confirmLabel}
                </Button>
              </div>
            </form>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
