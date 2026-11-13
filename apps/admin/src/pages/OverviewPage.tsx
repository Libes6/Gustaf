import type * as React from "react";

import { useOverview } from "../api/queries";
import type { Overview } from "../api/types";
import { ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Card, CardTitle } from "../components/ui/card";
import { formatBytes, formatCount, formatDateTime, formatDay, shortCommit } from "../lib/format";
import { formatPlatform, groupVersions } from "../lib/versions";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

function Stat({
  title,
  value,
  hint,
}: {
  readonly title: string;
  readonly value: string;
  readonly hint?: string;
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}

function SignupChart({ days }: { readonly days: Overview["signupsByDay"] }) {
  const total = days.reduce((sum, day) => sum + day.count, 0);
  if (days.length === 0 || total === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {strings.overview.signupsEmpty}
      </p>
    );
  }
  const max = Math.max(...days.map((day) => day.count));
  const barWidth = 100 / days.length;
  const first = days[0];
  const last = days.at(-1);
  return (
    <figure className="mt-3">
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        role="img"
        aria-label={strings.overview.signupsSummary(total)}
        className="h-36 w-full text-primary"
      >
        {days.map((day, index) => {
          const height = (day.count / max) * 38;
          return (
            <rect
              key={day.date}
              x={index * barWidth + barWidth * 0.15}
              y={40 - Math.max(height, day.count > 0 ? 0.8 : 0.3)}
              width={barWidth * 0.7}
              height={Math.max(height, day.count > 0 ? 0.8 : 0.3)}
              rx={0.4}
              className={day.count > 0 ? "fill-current" : "fill-border"}
            >
              <title>{`${formatDay(day.date)}: ${day.count}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums">
        <span>{first ? formatDay(first.date) : null}</span>
        <span>{strings.overview.signupsSummary(total)}</span>
        <span>{last ? formatDay(last.date) : null}</span>
      </figcaption>
    </figure>
  );
}

function VersionChart({ rows }: { readonly rows: Overview["versions"] }) {
  const groups = groupVersions(rows);
  if (groups.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {strings.overview.versionsEmpty}
      </p>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-5">
      {groups.map((group) => (
        <section key={group.kind}>
          <h3 className="text-xs font-medium text-muted-foreground">
            {strings.overview.versionsTotal(strings.kinds[group.kind], group.total)}
          </h3>
          <ul className="mt-2 flex flex-col gap-2">
            {group.versions.map((entry, index) => (
              <li
                key={entry.version}
                aria-label={strings.overview.versionDevices(entry.version, entry.devices)}
              >
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-xs">{entry.version}</span>
                    {index === 0 ? (
                      <Badge variant="success">{strings.overview.latest}</Badge>
                    ) : null}
                  </span>
                  <span className="tabular-nums">{formatCount(entry.devices)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border">
                  <div
                    className={index === 0 ? "h-full bg-success" : "h-full bg-primary"}
                    style={{ width: `${(entry.devices / group.total) * 100}%` }}
                  />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">
                  {entry.platforms
                    .map(({ platform, devices }) => `${formatPlatform(platform)} ${devices}`)
                    .join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right tabular-nums">{children}</dd>
    </div>
  );
}

export function OverviewPage() {
  const overview = useOverview();
  return (
    <>
      <PageTitle>{strings.overview.title}</PageTitle>
      {overview.isPending ? (
        <LoadingState />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <OverviewContent data={overview.data} />
      )}
    </>
  );
}

function OverviewContent({ data }: { readonly data: Overview }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          title={strings.overview.users}
          value={formatCount(data.users.total)}
          hint={strings.overview.usersHint(data.users.last7d, data.users.banned)}
        />
        <Stat
          title={strings.overview.devices}
          value={formatCount(data.devices.total)}
          hint={strings.overview.devicesHint(
            data.devices.active7d,
            data.devices.byKind.computer,
            data.devices.byKind.phone,
          )}
        />
        <Stat title={strings.overview.sessions} value={formatCount(data.sessions.active)} />
        <Stat
          title={strings.overview.relay}
          value={formatBytes(data.relay.bytesThisMonth)}
          hint={strings.overview.relayHint(data.relay.users)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          title={strings.overview.activeToday}
          value={formatCount(data.activeUsers.today)}
          hint={strings.overview.activeHint}
        />
        <Stat title={strings.overview.active7d} value={formatCount(data.activeUsers.last7d)} />
        <Stat title={strings.overview.active30d} value={formatCount(data.activeUsers.last30d)} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>{strings.overview.signups}</CardTitle>
          <SignupChart days={data.signupsByDay} />
        </Card>
        <Card>
          <CardTitle>{strings.overview.versions}</CardTitle>
          <VersionChart rows={data.versions} />
        </Card>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardTitle>{strings.overview.build}</CardTitle>
          <dl className="mt-2 divide-y">
            <Row label={strings.overview.version}>{data.build.version}</Row>
            <Row label={strings.overview.commit}>
              <code className="font-mono text-xs">{shortCommit(data.build.commit)}</code>
            </Row>
            <Row label={strings.overview.startedAt}>{formatDateTime(data.build.startedAt)}</Row>
          </dl>
        </Card>
        <Card>
          <CardTitle>{strings.overview.database}</CardTitle>
          <dl className="mt-2 divide-y">
            <Row label={strings.overview.database}>
              <Badge variant={data.db.ok ? "success" : "error"}>
                {data.db.ok ? strings.overview.dbOk : strings.overview.dbDown}
              </Badge>
            </Row>
            <Row label={strings.overview.migrations}>{formatCount(data.db.migrations)}</Row>
          </dl>
        </Card>
      </div>
    </div>
  );
}
