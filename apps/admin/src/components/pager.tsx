import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { strings } from "../strings";
import { Button } from "./ui/button";

export function Pager({
  page,
  hasPrevious,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: {
  readonly page: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly busy: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  if (!hasPrevious && !hasNext) return null;
  return (
    <nav
      aria-label={strings.common.pagination}
      className="flex items-center justify-end gap-2 border-t px-3 py-2"
    >
      <span className="me-auto text-xs text-muted-foreground" aria-live="polite">
        {strings.common.page(page)}
      </span>
      <Button variant="outline" size="sm" disabled={!hasPrevious || busy} onClick={onPrevious}>
        <ChevronLeftIcon aria-hidden />
        {strings.common.previous}
      </Button>
      <Button variant="outline" size="sm" disabled={!hasNext || busy} onClick={onNext}>
        {strings.common.next}
        <ChevronRightIcon aria-hidden />
      </Button>
    </nav>
  );
}
