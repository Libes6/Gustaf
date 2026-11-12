import type * as React from "react";

import { useOverview } from "../api/queries";
import type { Overview } from "../api/types";
import { ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Card, CardTitle } from "../components/ui/card";
import { formatCount, formatDateTime, formatDay, shortCommit } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

function Stat({
  title,
  value,
  hint,
}: {
  readonly title: string;
  readonly value: number;
  readonly hint?: string;
}) {
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCount(value)}</p>
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
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          title={strings.overview.users}
          value={data.users.total}
          hint={strings.overview.usersHint(data.users.last7d, data.users.banned)}
        />
        <Stat
          title={strings.overview.devices}
          value={data.devices.total}
          hint={strings.overview.devicesHint(
            data.devices.active7d,
            data.devices.byKind.computer,
            data.devices.byKind.phone,
          )}
        />
        <Stat title={strings.overview.sessions} value={data.sessions.active} />
      </div>
      <Card>
        <CardTitle>{strings.overview.signups}</CardTitle>
        <SignupChart days={data.signupsByDay} />
      </Card>
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
