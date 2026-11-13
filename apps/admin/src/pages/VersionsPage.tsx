import { useId, useState } from "react";

import { api } from "../api/instance";
import { useAdminAction, useMinimumVersions } from "../api/queries";
import type { ClientKind, MinimumVersion } from "../api/types";
import { ErrorState, LoadingState } from "../components/states";
import { Button } from "../components/ui/button";
import { Card, CardTitle } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input, Label } from "../components/ui/input";
import { optional } from "../lib/client-config";
import { formatDateTime } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

const t = strings.versions;
const KINDS: ReadonlyArray<ClientKind> = ["desktop", "mobile"];

export function VersionsPage() {
  const result = useMinimumVersions();
  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <p className="-mt-3 mb-4 text-sm text-muted-foreground">{t.description}</p>
      {result.isPending ? (
        <LoadingState />
      ) : result.isError ? (
        <ErrorState error={result.error} onRetry={() => void result.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {KINDS.map((kind) => {
            const current = result.data.items.find((item) => item.kind === kind) ?? null;
            // Remount on a saved change so the form shows what the server stored.
            return (
              <VersionCard
                key={`${kind}-${current?.updatedAt ?? ""}`}
                kind={kind}
                current={current}
              />
            );
          })}
        </div>
      )}
    </>
  );
}

function VersionCard({
  kind,
  current,
}: {
  readonly kind: ClientKind;
  readonly current: MinimumVersion | null;
}) {
  const id = useId();
  const [version, setVersion] = useState(current?.version ?? "");
  const [message, setMessage] = useState(current?.message ?? "");
  const [clearing, setClearing] = useState(false);
  const save = useAdminAction(
    () => api.setMinimumVersion(kind, { version: version.trim(), message: optional(message) }),
    () => strings.saved,
  );
  const clear = useAdminAction(
    () => api.clearMinimumVersion(kind),
    () => strings.deleted,
    () => setClearing(false),
  );
  const label = strings.clientKinds[kind];

  return (
    <Card>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(undefined);
        }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <CardTitle>{label}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {current ? t.updated(formatDateTime(current.updatedAt)) : t.notSet}
          </span>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-version`}>{t.version}</Label>
          <Input
            id={`${id}-version`}
            required
            placeholder={t.versionPlaceholder}
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-message`}>{t.message}</Label>
          <Input
            id={`${id}-message`}
            maxLength={500}
            placeholder={t.messagePlaceholder}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          {current ? (
            <Button type="button" variant="destructive-outline" onClick={() => setClearing(true)}>
              {t.clear}
            </Button>
          ) : null}
          <Button type="submit" disabled={save.isPending || !version.trim()}>
            {t.save}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title={t.clearTitle(label.toLowerCase())}
        description={t.clearBody}
        confirmLabel={t.clear}
        destructive
        pending={clear.isPending}
        onConfirm={() => clear.mutate(undefined)}
      />
    </Card>
  );
}
