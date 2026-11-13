import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { useAiUsage } from "../api/queries";
import type { AiUsageCounts, AiUsageSummary, UsagePeriod } from "../api/types";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Card, CardTitle } from "../components/ui/card";
import { Label, NativeSelect } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { formatCount, formatTokens } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

const PERIODS: ReadonlyArray<UsagePeriod> = [1, 7, 30, 90];

function PeriodSelect({
  value,
  onChange,
}: {
  readonly value: UsagePeriod;
  readonly onChange: (period: UsagePeriod) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="sr-only">
        {strings.aiUsage.periodLabel}
      </Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as UsagePeriod)}
      >
        {PERIODS.map((period) => (
          <option key={period} value={period}>
            {strings.aiUsage.periods[period]}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function CountCells({ counts }: { readonly counts: AiUsageCounts }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatCount(counts.turns)}</TableCell>
      <TableCell
        className="text-right tabular-nums"
        title={strings.aiUsage.measured(counts.measuredTurns, counts.turns)}
      >
        {formatTokens(counts.inputTokens, counts.measuredTurns)}
      </TableCell>
      <TableCell
        className="text-right tabular-nums max-sm:hidden"
        title={strings.aiUsage.measured(counts.measuredTurns, counts.turns)}
      >
        {formatTokens(counts.outputTokens, counts.measuredTurns)}
      </TableCell>
    </>
  );
}

function CountHeads() {
  return (
    <>
      <TableHead className="text-right">{strings.aiUsage.turns}</TableHead>
      <TableHead className="text-right">{strings.aiUsage.inputTokens}</TableHead>
      <TableHead className="text-right max-sm:hidden">{strings.aiUsage.outputTokens}</TableHead>
    </>
  );
}

function ModelTable({ rows }: { readonly rows: AiUsageSummary["byModel"] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{strings.aiUsage.provider}</TableHead>
          <TableHead>{strings.aiUsage.model}</TableHead>
          <CountHeads />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.provider}\n${row.model ?? ""}`}>
            <TableCell className="font-medium">{row.provider}</TableCell>
            <TableCell className={row.model === null ? "text-muted-foreground" : undefined}>
              {row.model ?? strings.aiUsage.unnamedModel}
            </TableCell>
            <CountCells counts={row} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Totals({ totals }: { readonly totals: AiUsageSummary["totals"] }) {
  const items = [
    [strings.aiUsage.turns, formatCount(totals.turns)],
    [strings.aiUsage.inputTokens, formatTokens(totals.inputTokens, totals.measuredTurns)],
    [strings.aiUsage.outputTokens, formatTokens(totals.outputTokens, totals.measuredTurns)],
    [strings.aiUsage.users, formatCount(totals.users)],
  ] as const;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map(([title, value]) => (
        <Card key={title}>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        </Card>
      ))}
      {totals.turns > 0 ? (
        <p className="col-span-full text-xs text-muted-foreground">
          {strings.aiUsage.measured(totals.measuredTurns, totals.turns)}
        </p>
      ) : null}
    </div>
  );
}

export function AiUsagePage() {
  const [days, setDays] = useState<UsagePeriod>(30);
  const result = useAiUsage(days);
  return (
    <>
      <PageTitle>{strings.aiUsage.title}</PageTitle>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">{strings.aiUsage.description}</p>
        <PeriodSelect value={days} onChange={setDays} />
      </div>
      {result.isPending ? (
        <LoadingState />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : result.data.totals.turns === 0 ? (
        <Card>
          <EmptyState message={strings.aiUsage.empty} />
        </Card>
      ) : (
        <div aria-busy={result.isFetching} className="flex flex-col gap-4">
          <Totals totals={result.data.totals} />
          <Card className="p-0">
            <CardTitle className="px-4 pt-4">{strings.aiUsage.byModel}</CardTitle>
            <ModelTable rows={result.data.byModel} />
          </Card>
          <Card className="p-0">
            <CardTitle className="px-4 pt-4">{strings.aiUsage.byUser}</CardTitle>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{strings.aiUsage.user}</TableHead>
                  <CountHeads />
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.byUser.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell className="max-w-56 truncate">
                      <Link
                        to="/users/$userId"
                        params={{ userId: row.userId }}
                        className="rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {row.name}
                      </Link>
                      <span className="block truncate text-xs text-muted-foreground">
                        {row.email}
                      </span>
                    </TableCell>
                    <CountCells counts={row} />
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}
    </>
  );
}

/** One user's AI usage by provider and model, for the user detail page. */
export function UserAiUsage({ userId }: { readonly userId: string }) {
  const [days, setDays] = useState<UsagePeriod>(30);
  const result = useAiUsage(days, userId);
  return (
    <Card className="p-0">
      <div className="flex items-center justify-between gap-2 px-4 pt-4">
        <CardTitle>{strings.aiUsage.title}</CardTitle>
        <PeriodSelect value={days} onChange={setDays} />
      </div>
      {result.isPending ? (
        <LoadingState />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : result.data.byModel.length === 0 ? (
        <EmptyState message={strings.aiUsage.empty} />
      ) : (
        <div aria-busy={result.isFetching}>
          <ModelTable rows={result.data.byModel} />
        </div>
      )}
    </Card>
  );
}
