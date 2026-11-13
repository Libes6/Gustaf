import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useReports } from "../api/queries";
import type { ReportStatus } from "../api/types";
import { Pager } from "../components/pager";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Label, NativeSelect } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { formatDateTime } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

function parseStatus(value: string): ReportStatus | undefined {
  return value === "new" || value === "seen" || value === "closed" ? value : undefined;
}

export function ReportStatusBadge({ status }: { readonly status: ReportStatus }) {
  const variant = status === "new" ? "primary" : status === "closed" ? "success" : "secondary";
  return <Badge variant={variant}>{strings.reports.statuses[status]}</Badge>;
}

export function ReportsPage() {
  const statusId = useId();
  const [status, setStatus] = useState<ReportStatus | undefined>("new");
  const list = useReports(status);
  const { query: result } = list;
  const columns = strings.reports.columns;

  return (
    <>
      <PageTitle>{strings.reports.title}</PageTitle>
      <div className="mb-4 flex items-center gap-2">
        <Label htmlFor={statusId} className="sr-only">
          {strings.reports.statusLabel}
        </Label>
        <NativeSelect
          id={statusId}
          value={status ?? ""}
          onChange={(event) => setStatus(parseStatus(event.target.value))}
        >
          <option value="">{strings.reports.allStatuses}</option>
          <option value="new">{strings.reports.statuses.new}</option>
          <option value="seen">{strings.reports.statuses.seen}</option>
          <option value="closed">{strings.reports.statuses.closed}</option>
        </NativeSelect>
      </div>
      <Card className="p-0">
        {result.isPending ? (
          <LoadingState />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message={strings.reports.empty} />
        ) : (
          <>
            <Table aria-busy={result.isFetching}>
              <TableHeader>
                <TableRow>
                  <TableHead>{columns.report}</TableHead>
                  <TableHead className="max-sm:hidden">{columns.user}</TableHead>
                  <TableHead className="max-md:hidden">{columns.client}</TableHead>
                  <TableHead className="max-lg:hidden">{columns.created}</TableHead>
                  <TableHead>{columns.status}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((report) => (
                  <TableRow key={report.id}>
                    <TableCell className="max-w-80">
                      <Link
                        to="/reports/$reportId"
                        params={{ reportId: report.id }}
                        className="line-clamp-2 rounded-sm whitespace-normal outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {report.preview}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-48 truncate max-sm:hidden">
                      {report.userName}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-md:hidden">
                      {strings.reports.clients[report.client]} {report.appVersion}
                      {report.hasLogs ? (
                        <>
                          {" "}
                          <Badge variant="outline">{strings.reports.withLogs}</Badge>
                        </>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-lg:hidden">
                      {formatDateTime(report.createdAt)}
                    </TableCell>
                    <TableCell>
                      <ReportStatusBadge status={report.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
