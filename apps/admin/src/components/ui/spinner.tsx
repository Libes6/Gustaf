import { Loader2Icon } from "lucide-react";

import { strings } from "../../strings";

export function Spinner() {
  return (
    <Loader2Icon
      role="status"
      aria-label={strings.common.loading}
      className="size-4 animate-spin text-muted-foreground"
    />
  );
}
