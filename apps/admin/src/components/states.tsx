import { CircleAlertIcon, InboxIcon } from "lucide-react";

import { errorMessage } from "../lib/format";
import { strings } from "../strings";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export function LoadingState() {
  return (
    <div className="flex min-h-48 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
      <Spinner />
      <span>{strings.common.loading}</span>
    </div>
  );
}

export function EmptyState({ message }: { readonly message: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
      <span className="grid size-10 place-items-center rounded-full bg-accent">
        <InboxIcon aria-hidden className="size-5" />
      </span>
      <p className="max-w-[48ch]">{message}</p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-48 flex-col items-center justify-center gap-3 p-6 text-center text-sm"
    >
      <span className="grid size-10 place-items-center rounded-full bg-destructive/8 dark:bg-destructive/16">
        <CircleAlertIcon aria-hidden className="size-5 text-destructive-foreground" />
      </span>
      <div className="max-w-[56ch]">
        <p className="font-medium">{strings.errors.title}</p>
        <p className="mt-0.5 text-muted-foreground wrap-anywhere">{errorMessage(error)}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {strings.common.retry}
        </Button>
      ) : null}
    </div>
  );
}
