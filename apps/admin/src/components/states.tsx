import { CircleAlertIcon, InboxIcon } from "lucide-react";

import { errorMessage } from "../lib/format";
import { strings } from "../strings";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";

export function LoadingState() {
  return (
    <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      <span>{strings.common.loading}</span>
    </div>
  );
}

export function EmptyState({ message }: { readonly message: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <InboxIcon aria-hidden className="size-5" />
      <p>{message}</p>
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
      className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-sm"
    >
      <CircleAlertIcon aria-hidden className="size-5 text-destructive" />
      <div>
        <p className="font-medium">{strings.errors.title}</p>
        <p className="text-muted-foreground">{errorMessage(error)}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {strings.common.retry}
        </Button>
      ) : null}
    </div>
  );
}
