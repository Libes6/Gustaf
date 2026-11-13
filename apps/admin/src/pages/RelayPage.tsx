import { Link } from "@tanstack/react-router";

import { useRelayHealth } from "../api/queries";
import { RELAY_FAILURES, type RelayHealth } from "../api/types";
import { DailyBars, Meter } from "../components/charts";
import { ErrorState, LoadingState } from "../components/states";
import { Card, CardTitle } from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { formatBytes, formatCount, formatDateTime, formatPercent } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";
import { Stat } from "./OverviewPage";

export function RelayPage() {
  const relay = useRelayHealth();
  return (
    <>
      <PageTitle>{strings.relay.title}</PageTitle>
      {relay.isPending ? (
        <LoadingState />
      ) : relay.isError ? (
        <ErrorState error={relay.error} onRetry={() => void relay.refetch()} />
      ) : (
        <RelayContent data={relay.data} />
      )}
    </>
  );
}

function RelayContent({ data }: { readonly data: RelayHealth }) {
  const { live, days } = data;
  const totalBytes = days.reduce((sum, day) => sum + day.bytes, 0);
  const totalConnections = days.reduce((sum, day) => sum + day.connected, 0);
  const today = days.at(-1);
  const failures = RELAY_FAILURES.map((reason) => ({
    reason,
    sinceStart: live.counts[reason],
    last30: days.reduce((sum, day) => sum + day[reason], 0),
    today: today?.[reason] ?? 0,
  })).filter((row) => row.sinceStart + row.last30 > 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat title={strings.relay.hostsOnline} value={formatCount(live.hostsOnline)} />
        <Stat title={strings.relay.clientsOnline} value={formatCount(live.clientsOnline)} />
        <Stat title={strings.relay.openTunnels} value={formatCount(live.openTunnels)} />
        <Stat
          title={strings.relay.connections}
          value={formatCount(live.counts.connected)}
          hint={strings.relay.connectionsHint(live.counts.attempt, formatDateTime(live.since))}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>{strings.relay.traffic}</CardTitle>
          <DailyBars
            days={days.map((day) => ({ date: day.date, value: day.bytes }))}
            format={formatBytes}
            summary={strings.relay.trafficSummary(formatBytes(totalBytes))}
            empty={strings.relay.trafficEmpty}
          />
        </Card>
        <Card>
          <CardTitle>{strings.relay.dailyConnections}</CardTitle>
          <DailyBars
            days={days.map((day) => ({ date: day.date, value: day.connected }))}
            format={formatCount}
            summary={strings.relay.dailyConnectionsSummary(totalConnections)}
            empty={strings.relay.dailyConnectionsEmpty}
          />
        </Card>
      </div>
      <Card className="p-0">
        <div className="p-4 pb-2">
          <CardTitle>{strings.relay.failures}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">{strings.relay.failuresHint}</p>
        </div>
        {failures.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{strings.relay.noFailures}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{strings.relay.reason}</TableHead>
                <TableHead className="text-right">{strings.relay.sinceStart}</TableHead>
                <TableHead className="text-right">{strings.relay.today}</TableHead>
                <TableHead className="text-right">{strings.relay.last30}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {failures.map((row) => (
                <TableRow key={row.reason}>
                  <TableCell>{strings.relay.reasons[row.reason] ?? row.reason}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(row.sinceStart)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(row.today)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCount(row.last30)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <Card className="p-0">
        <div className="p-4 pb-2">
          <CardTitle>{strings.relay.topUsers}</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            {strings.relay.topUsersHint(formatBytes(data.monthlyLimitBytes))}
          </p>
        </div>
        {data.topUsers.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">{strings.relay.topUsersEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{strings.relay.user}</TableHead>
                <TableHead className="text-right">{strings.relay.used}</TableHead>
                <TableHead className="w-1/3 min-w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topUsers.map((row) => (
                <TableRow key={row.userId}>
                  <TableCell>
                    <Link
                      to="/users/$userId"
                      params={{ userId: row.userId }}
                      className="font-medium hover:underline"
                    >
                      {row.name}
                    </Link>
                    {row.githubLogin ? (
                      <span className="ms-2 text-xs text-muted-foreground">@{row.githubLogin}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatBytes(row.bytes)} · {formatPercent(row.percent)}
                  </TableCell>
                  <TableCell>
                    <Meter percent={row.percent} label={`${row.name} ${strings.relay.used}`} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
