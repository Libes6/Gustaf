import { useReleaseStats } from "../api/queries";
import type { Platform, ReleaseStats } from "../api/types";
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
import { formatBytes, formatCount, formatDateTime, formatRelative } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";
import { Stat } from "./OverviewPage";

const PLATFORM_ORDER: ReadonlyArray<Platform> = [
  "macos",
  "windows",
  "linux",
  "android",
  "ios",
  "other",
];

export function ReleasesPage() {
  const releases = useReleaseStats();
  return (
    <>
      <PageTitle>{strings.releases.title}</PageTitle>
      {releases.isPending ? (
        <LoadingState />
      ) : releases.isError ? (
        <ErrorState error={releases.error} onRetry={() => void releases.refetch()} />
      ) : releases.data.status === "error" ? (
        <Card>
          <p className="text-sm text-destructive-foreground">
            {strings.releases.error(releases.data.message)}
          </p>
        </Card>
      ) : (
        <ReleasesContent data={releases.data} now={releases.dataUpdatedAt} />
      )}
    </>
  );
}

function ReleasesContent({
  data,
  now,
}: {
  readonly data: Extract<ReleaseStats, { status: "ok" }>;
  readonly now: number;
}) {
  const platforms = PLATFORM_ORDER.filter(
    (platform) => data.byPlatform[platform].installer + data.byPlatform[platform].update > 0,
  );
  const max = Math.max(
    1,
    ...platforms.map((p) => data.byPlatform[p].installer + data.byPlatform[p].update),
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Stat
          title={strings.releases.total}
          value={formatCount(data.total)}
          hint={strings.releases.totalHint}
        />
        <Card className="md:col-span-2">
          <CardTitle>{strings.releases.platform}</CardTitle>
          <ul className="mt-3 flex flex-col gap-2">
            {platforms.map((platform) => {
              const { installer, update } = data.byPlatform[platform];
              return (
                <li key={platform} className="grid grid-cols-[5rem_1fr_auto] items-center gap-3">
                  <span className="text-sm">{strings.releases.platforms[platform]}</span>
                  <div className="flex h-2 overflow-hidden rounded-full bg-accent">
                    <div className="bg-primary" style={{ width: `${(installer / max) * 100}%` }} />
                    <div className="bg-primary/40" style={{ width: `${(update / max) * 100}%` }} />
                  </div>
                  <span className="text-right text-xs text-muted-foreground tabular-nums">
                    {formatCount(installer)} {strings.releases.installers.toLowerCase()}
                    {update > 0
                      ? ` · ${formatCount(update)} ${strings.releases.updates.toLowerCase()}`
                      : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        {strings.releases.fetchedAt(formatRelative(data.fetchedAt, now))}
      </p>
      {data.releases.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground">{strings.releases.empty}</p>
        </Card>
      ) : (
        data.releases.map((release) => {
          const visible = release.assets.filter((asset) => asset.kind !== "metadata");
          const metadata = release.assets.filter((asset) => asset.kind === "metadata");
          return (
            <Card key={release.tag} className="p-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-4 pb-2">
                <h2 className="font-medium">{release.name ?? release.tag}</h2>
                {release.prerelease ? (
                  <Badge variant="warning">{strings.releases.prerelease}</Badge>
                ) : null}
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(release.publishedAt)}
                </span>
                <span className="ms-auto text-sm tabular-nums">
                  {formatCount(release.downloads)} {strings.releases.downloads.toLowerCase()}
                </span>
              </div>
              <AssetTable assets={visible} />
              {metadata.length > 0 ? (
                <details className="border-t px-4 py-2 text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {strings.releases.showMetadata}
                  </summary>
                  <AssetTable assets={metadata} />
                </details>
              ) : null}
            </Card>
          );
        })
      )}
    </div>
  );
}

function AssetTable({
  assets,
}: {
  readonly assets: Extract<ReleaseStats, { status: "ok" }>["releases"][number]["assets"];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{strings.releases.asset}</TableHead>
          <TableHead>{strings.releases.platform}</TableHead>
          <TableHead>{strings.releases.kind}</TableHead>
          <TableHead className="text-right">{strings.releases.size}</TableHead>
          <TableHead className="text-right">{strings.releases.downloads}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {assets.map((asset) => (
          <TableRow key={asset.name}>
            <TableCell className="font-mono text-xs">{asset.name}</TableCell>
            <TableCell>{strings.releases.platforms[asset.platform]}</TableCell>
            <TableCell>{strings.releases.kinds[asset.kind]}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatBytes(asset.sizeBytes)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCount(asset.downloads)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
