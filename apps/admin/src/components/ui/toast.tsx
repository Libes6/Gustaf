import { Toast } from "@base-ui/react/toast";
import { CircleAlertIcon, CircleCheckIcon, XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "../../lib/utils";
import { strings } from "../../strings";

export const toastManager = Toast.createToastManager();

export function notify(type: "success" | "error", title: string, description?: string) {
  toastManager.add({ type, title, description, priority: type === "error" ? "high" : "low" });
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className={cn(
        "pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg transition-[opacity,translate] duration-150 data-ending-style:translate-y-2 data-ending-style:opacity-0 data-starting-style:translate-y-2 data-starting-style:opacity-0",
      )}
    >
      {toast.type === "error" ? (
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 text-destructive" />
      ) : (
        <CircleCheckIcon aria-hidden className="mt-0.5 size-4 text-success" />
      )}
      <Toast.Content className="min-w-0 flex-1">
        <Toast.Title className="text-sm font-medium wrap-break-word" />
        <Toast.Description className="text-sm text-muted-foreground wrap-break-word" />
      </Toast.Content>
      <Toast.Close
        aria-label={strings.common.dismiss}
        className="-m-1 rounded-md p-1 text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon aria-hidden className="size-4" />
      </Toast.Close>
    </Toast.Root>
  ));
}

export function ToastProvider({ children }: { readonly children: React.ReactNode }) {
  return (
    <Toast.Provider toastManager={toastManager}>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="pointer-events-none fixed inset-x-4 bottom-4 z-60 flex flex-col gap-2 sm:left-auto sm:w-96">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}
