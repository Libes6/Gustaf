import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";

import { api } from "../api/instance";
import { useAdminAction, useDevices } from "../api/queries";
import type { AdminDevice, DeviceKind } from "../api/types";
import { Pager } from "../components/pager";
import { SearchForm } from "../components/search-form";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
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

function parseKind(value: string): DeviceKind | undefined {
  return value === "computer" || value === "phone" ? value : undefined;
}

export function DevicesPage() {
  const kindId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<DeviceKind | undefined>(undefined);
  const [target, setTarget] = useState<AdminDevice | null>(null);
  const list = useDevices(query, kind);
  const { query: result } = list;
  const revoke = useAdminAction(
    (device: AdminDevice) => api.revokeDevice(device.id),
    (device) => strings.toasts.deviceRevoked(device.name),
  );
  const columns = strings.devices.columns;

  return (
    <>
      <PageTitle>{strings.devices.title}</PageTitle>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchForm
          label={strings.devices.searchLabel}
          placeholder={strings.devices.searchPlaceholder}
          defaultValue={query}
          onSearch={setQuery}
        />
        <div className="flex items-center gap-2">
          <Label htmlFor={kindId} className="sr-only">
            {strings.devices.kindLabel}
          </Label>
          <NativeSelect
            id={kindId}
            value={kind ?? ""}
            onChange={(event) => setKind(parseKind(event.target.value))}
          >
            <option value="">{strings.devices.allKinds}</option>
            <option value="computer">{strings.kinds.computer}</option>
            <option value="phone">{strings.kinds.phone}</option>
          </NativeSelect>
        </div>
      </div>
      <Card className="p-0">
        {result.isPending ? (
          <LoadingState />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message={strings.devices.empty} />
        ) : (
          <>
            <Table aria-busy={result.isFetching}>
              <TableHeader>
                <TableRow>
                  <TableHead>{columns.device}</TableHead>
                  <TableHead className="max-sm:hidden">{columns.kind}</TableHead>
                  <TableHead>{columns.owner}</TableHead>
                  <TableHead className="max-md:hidden">{columns.lastSeen}</TableHead>
                  <TableHead className="max-lg:hidden">{columns.created}</TableHead>
                  <TableHead>{columns.status}</TableHead>
                  <TableHead>
                    <span className="sr-only">{strings.users.actions}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell className="max-w-48 truncate font-medium">{device.name}</TableCell>
                    <TableCell className="max-sm:hidden">{strings.kinds[device.kind]}</TableCell>
                    <TableCell>
                      <Link
                        to="/users/$userId"
                        params={{ userId: device.userId }}
                        className="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {device.userName}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground max-md:hidden">
                      {formatDateTime(device.lastSeenAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-lg:hidden">
                      {formatDateTime(device.createdAt)}
                    </TableCell>
                    <TableCell>
                      {device.revokedAt ? (
                        <Badge variant="error">{strings.users.revoked}</Badge>
                      ) : (
                        <Badge variant="success">{strings.devices.active}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {device.revokedAt ? null : (
                        <Button
                          variant="destructive-outline"
                          size="sm"
                          onClick={() => setTarget(device)}
                        >
                          {strings.actions.revokeDevice}
                        </Button>
                      )}
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
      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        title={strings.confirm.revokeDeviceTitle(target?.name ?? "", target?.userName ?? "")}
        description={strings.confirm.revokeDeviceBody}
        confirmLabel={strings.actions.revokeDevice}
        destructive
        pending={revoke.isPending}
        onConfirm={() => target && revoke.mutate(target, { onSuccess: () => setTarget(null) })}
      />
    </>
  );
}
