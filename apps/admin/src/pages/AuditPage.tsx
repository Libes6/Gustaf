import { ChevronRightIcon } from "lucide-react";

import { useAudit } from "../api/queries";
import type { AuditEntry } from "../api/types";
import { Pager } from "../components/pager";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { auditActionLabel, formatDateTime, formatMeta, hasMeta } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

function actionVariant(action: string) {
  if (action === "user.ban" || action === "user.delete" || action === "device.revoke") {
    return "error" as const;
  }
  if (action === "user.role_change") return "primary" as const;
  return "secondary" as const;
}

function AuditItem({ entry }: { readonly entry: AuditEntry }) {
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Badge variant={actionVariant(entry.action)}>{auditActionLabel(entry.action)}</Badge>
        <span className="font-mono text-xs text-muted-foreground wrap-anywhere">
          {strings.audit.target(entry.targetType, entry.targetId)}
        </span>
        <span className="text-muted-foreground">{strings.audit.by(entry.actorName)}</span>
        <time dateTime={entry.at} className="ms-auto text-xs text-muted-foreground tabular-nums">
          {formatDateTime(entry.at)}
        </time>
      </div>
      {hasMeta(entry.meta) ? (
        <details className="group text-sm">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 transition-transform group-open:rotate-90"
            />
            {strings.audit.details}
          </summary>
          <pre className="mt-1.5 max-h-80 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs">
            {formatMeta(entry.meta)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

export function AuditPage() {
  const list = useAudit();
  const { query: result } = list;
  return (
    <>
      <PageTitle>{strings.audit.title}</PageTitle>
      <Card className="p-0">
        {result.isPending ? (
          <LoadingState />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message={strings.audit.empty} />
        ) : (
          <>
            <ul className="divide-y" aria-busy={result.isFetching}>
              {result.data.items.map((entry) => (
                <AuditItem key={entry.id} entry={entry} />
              ))}
            </ul>
            <Pager
              page={list.page}
              hasPrevious={list.hasPrevious}
              hasNext={list.hasNext}
              busy={result.isFetching}
              onPrevious={list.previous}
              onNext={list.next}
            />
          </>
        )}
      </Card>
    </>
  );
}
