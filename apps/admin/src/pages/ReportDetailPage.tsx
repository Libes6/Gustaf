import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useId, useState } from "react";
import type * as React from "react";

import { api } from "../api/instance";
import { useAdminAction, useReport } from "../api/queries";
import type { ReportDetail, ReportStatus } from "../api/types";
import { ErrorState, LoadingState } from "../components/states";
import { Button } from "../components/ui/button";
import { Card, CardTitle } from "../components/ui/card";
import { Label, Textarea } from "../components/ui/input";
import { formatDateTime } from "../lib/format";
import { strings } from "../strings";
import { ReportStatusBadge } from "./ReportsPage";

export function ReportDetailPage() {
  const { reportId } = useParams({ from: "/reports/$reportId" });
  const report = useReport(reportId);
  return (
    <>
      <Link
        to="/reports"
        className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        {strings.reports.back}
      </Link>
      {report.isPending ? (
        <LoadingState />
      ) : report.isError ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : (
        // Keyed so the note draft resets when another report opens.
        <ReportView key={report.data.id} report={report.data} />
      )}
    </>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere sm:text-right">{children}</dd>
    </div>
  );
}

const STATUS_ACTIONS: Record<ReportStatus, ReadonlyArray<{ to: ReportStatus; label: string }>> = {
  new: [
    { to: "seen", label: strings.reports.markSeen },
    { to: "closed", label: strings.reports.close },
  ],
  seen: [
    { to: "new", label: strings.reports.markNew },
    { to: "closed", label: strings.reports.close },
  ],
  closed: [{ to: "seen", label: strings.reports.reopen }],
};

function ReportView({ report }: { readonly report: ReportDetail }) {
  const noteId = useId();
  const [note, setNote] = useState(report.adminNote ?? "");
  const update = useAdminAction(
    (change: { readonly status?: ReportStatus; readonly note?: string | null }) =>
      api.updateReport(report.id, change),
    () => strings.reports.saved,
  );
  const noteChanged = note.trim() !== (report.adminNote ?? "");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-xl font-semibold tracking-tight">{strings.reports.title}</h1>
        <ReportStatusBadge status={report.status} />
        {STATUS_ACTIONS[report.status].map((action) => (
          <Button
            key={action.to}
            variant="outline"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: action.to })}
          >
            {action.label}
          </Button>
        ))}
      </div>

      <Card>
        <CardTitle>{strings.reports.message}</CardTitle>
        <p className="mt-2 text-sm whitespace-pre-wrap wrap-anywhere">{report.message}</p>
      </Card>

      <Card>
        <CardTitle>{strings.reports.details}</CardTitle>
        <dl className="mt-2 divide-y">
          <Field label={strings.reports.columns.user}>
            <Link
              to="/users/$userId"
              params={{ userId: report.userId }}
              className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {report.userName}
            </Link>{" "}
            <span className="text-muted-foreground">{report.userEmail}</span>
          </Field>
          <Field label={strings.reports.columns.client}>
            {strings.reports.clients[report.client]}
          </Field>
          <Field label={strings.reports.version}>{report.appVersion}</Field>
          <Field label={strings.reports.platform}>{report.platform}</Field>
          <Field label={strings.reports.device}>{report.deviceName ?? strings.common.none}</Field>
          <Field label={strings.reports.columns.created}>{formatDateTime(report.createdAt)}</Field>
          <Field label={strings.reports.updated}>{formatDateTime(report.updatedAt)}</Field>
        </dl>
      </Card>

      <Card>
        <Label htmlFor={noteId}>{strings.reports.note}</Label>
        <Textarea
          id={noteId}
          className="mt-2"
          value={note}
          maxLength={2000}
          placeholder={strings.reports.notePlaceholder}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={!noteChanged || update.isPending}
            onClick={() => update.mutate({ note: note.trim() || null })}
          >
            {strings.reports.saveNote}
          </Button>
        </div>
      </Card>

      <Card>
        <CardTitle>{strings.reports.logs}</CardTitle>
        {report.logs ? (
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md border bg-muted p-2 font-mono text-xs">
            {report.logs}
          </pre>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">{strings.reports.noLogs}</p>
        )}
      </Card>
    </div>
  );
}
