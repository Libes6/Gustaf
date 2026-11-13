import { useSystemStatus } from "../api/queries";
import type { BackupStatus, SystemStatus } from "../api/types";
import { Meter } from "../components/charts";
import { ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Card, CardTitle } from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatRelative,
  shortCommit,
} from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";
import { Row } from "./OverviewPage";

export function SystemPage() {
  const system = useSystemStatus();
  return (
    <>
      <PageTitle>{strings.system.title}</PageTitle>
      {system.isPending ? (
        <LoadingState />
      ) : system.isError ? (
        <ErrorState error={system.error} onRetry={() => void system.refetch()} />
      ) : (
        <SystemContent data={system.data} now={system.dataUpdatedAt} />
      )}
    </>
  );
}

function SystemContent({ data, now }: { readonly data: SystemStatus; readonly now: number }) {
  const { build, memory, disk, database } = data;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardTitle>{strings.system.api}</CardTitle>
          <dl className="mt-2 divide-y">
            <Row label={strings.system.version}>{build.version}</Row>
            <Row label={strings.system.commit}>
              <code className="font-mono text-xs">{shortCommit(build.commit)}</code>
            </Row>
            <Row label={strings.system.startedAt}>{formatDateTime(build.startedAt)}</Row>
            <Row label={strings.system.uptime}>{formatDuration(build.uptimeSeconds)}</Row>
            <Row label={strings.system.node}>{build.node}</Row>
          </dl>
        </Card>
        <Card>
          <CardTitle>{strings.system.memory}</CardTitle>
          <dl className="mt-2 divide-y">
            <Row label={strings.system.rss}>{formatBytes(memory.rssBytes)}</Row>
            <Row label={strings.system.heap}>
              {strings.system.heapValue(
                formatBytes(memory.heapUsedBytes),
                formatBytes(memory.heapTotalBytes),
              )}
            </Row>
            <Row label={strings.system.external}>{formatBytes(memory.externalBytes)}</Row>
          </dl>
        </Card>
        <Card>
          <CardTitle>{strings.system.disk}</CardTitle>
          {disk ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-sm tabular-nums">
                {strings.system.diskValue(
                  formatBytes(disk.freeBytes),
                  formatBytes(disk.totalBytes),
                )}
              </p>
              <Meter
                percent={disk.totalBytes > 0 ? (1 - disk.freeBytes / disk.totalBytes) * 100 : 0}
                label={strings.system.disk}
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">{strings.system.unavailable}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">{strings.system.diskHint}</p>
        </Card>
        <Card>
          <CardTitle>{strings.system.backups}</CardTitle>
          <Backups backups={data.backups} now={now} />
        </Card>
      </div>
      <Card className="p-0">
        <div className="flex items-baseline justify-between gap-4 p-4 pb-2">
          <CardTitle>{strings.system.database}</CardTitle>
          <span className="text-sm tabular-nums">
            {database
              ? `${strings.system.dbSize}: ${formatBytes(database.sizeBytes)}`
              : strings.system.unavailable}
          </span>
        </div>
        {database ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{strings.system.table}</TableHead>
                <TableHead className="text-right">{strings.system.tableSize}</TableHead>
                <TableHead className="text-right">{strings.system.tableRows}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {database.tables.map((table) => (
                <TableRow key={table.name}>
                  <TableCell className="font-mono text-xs">{table.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(table.bytes)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {table.rows === null ? strings.system.unknownRows : formatCount(table.rows)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Card>
    </div>
  );
}

function backupVariant(status: string) {
  if (status === "success") return "success" as const;
  if (status === "failed") return "error" as const;
  return "secondary" as const;
}

function Backups({ backups, now }: { readonly backups: BackupStatus; readonly now: number }) {
  if (backups.status === "not_configured") {
    return (
      <p className="mt-2 text-sm text-muted-foreground">{strings.system.backupsNotConfigured}</p>
    );
  }
  if (backups.status === "error") {
    return (
      <p className="mt-2 text-sm text-destructive-foreground">
        {strings.system.backupsError(backups.message)}
      </p>
    );
  }
  const { last } = backups;
  return (
    <>
      {backups.enabled === 0 ? (
        <p className="mt-2 text-sm text-warning-foreground">{strings.system.backupsNoSchedule}</p>
      ) : null}
      {last ? null : (
        <p className="mt-2 text-sm text-muted-foreground">{strings.system.backupsNone}</p>
      )}
      <dl className="mt-2 divide-y">
        {last ? (
          <>
            <Row label={strings.system.lastBackup}>
              {formatDateTime(last.finishedAt ?? last.startedAt)} (
              {formatRelative(last.finishedAt ?? last.startedAt, now)})
            </Row>
            <Row label={strings.system.backupStatus}>
              <Badge variant={backupVariant(last.status)}>{last.status}</Badge>
            </Row>
            {last.sizeBytes !== null ? (
              <Row label={strings.system.backupSize}>{formatBytes(last.sizeBytes)}</Row>
            ) : null}
          </>
        ) : null}
        <Row label={strings.system.schedule}>
          {backups.frequency ?? strings.common.none} ·{" "}
          {strings.system.schedules(backups.enabled, backups.schedules)}
        </Row>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {strings.system.checkedAt(formatRelative(backups.fetchedAt, now))}
      </p>
    </>
  );
}
