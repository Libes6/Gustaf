import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { api } from "../api/instance";
import { useAdminAction, useFeatureFlags } from "../api/queries";
import type { FeatureFlag, FeatureFlagInput, FlagMode } from "../api/types";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Input, Label, NativeSelect, Textarea } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { parseLogins } from "../lib/client-config";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

const t = strings.flags;
const MODES: ReadonlyArray<FlagMode> = ["off", "everyone", "listed"];
const MODE_BADGE = { off: "outline", everyone: "success", listed: "primary" } as const;

type Editing = { readonly key: string | null; readonly input: FeatureFlagInput };

const inputOf = ({ description, mode, logins }: FeatureFlag): FeatureFlagInput => ({
  description,
  mode,
  logins,
});

export function FeatureFlagsPage() {
  const id = useId();
  const result = useFeatureFlags();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<FeatureFlag | null>(null);
  const save = useAdminAction(
    ({ key, input, isNew }: { key: string; input: FeatureFlagInput; isNew: boolean }) =>
      isNew ? api.createFeatureFlag(key, input) : api.updateFeatureFlag(key, input),
    () => strings.saved,
    () => setEditing(null),
  );
  const remove = useAdminAction(
    (flag: FeatureFlag) => api.deleteFeatureFlag(flag.key),
    () => strings.deleted,
    () => setDeleting(null),
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <PageTitle>{t.title}</PageTitle>
          <p className="-mt-3 text-sm text-muted-foreground">{t.description}</p>
        </div>
        <Button
          onClick={() =>
            setEditing({ key: null, input: { description: "", mode: "off", logins: [] } })
          }
        >
          <PlusIcon aria-hidden />
          {t.new}
        </Button>
      </div>
      <Card className="p-0">
        {result.isPending ? (
          <LoadingState />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message={t.empty} />
        ) : (
          <Table aria-busy={result.isFetching}>
            <TableHeader>
              <TableRow>
                <TableHead>{t.columns.key}</TableHead>
                <TableHead className="max-md:hidden">{t.columns.description}</TableHead>
                <TableHead>{t.columns.mode}</TableHead>
                <TableHead>
                  <span className="sr-only">{strings.users.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((flag) => (
                <TableRow key={flag.key}>
                  <TableCell className="font-mono text-xs">{flag.key}</TableCell>
                  <TableCell className="max-w-72 truncate text-muted-foreground max-md:hidden">
                    {flag.description}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <label htmlFor={`${id}-${flag.key}`} className="sr-only">
                        {t.columns.mode}
                      </label>
                      <NativeSelect
                        id={`${id}-${flag.key}`}
                        value={flag.mode}
                        disabled={save.isPending}
                        onChange={(event) =>
                          save.mutate({
                            key: flag.key,
                            isNew: false,
                            input: { ...inputOf(flag), mode: event.target.value as FlagMode },
                          })
                        }
                      >
                        {MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {t.modes[mode]}
                          </option>
                        ))}
                      </NativeSelect>
                      {flag.mode === "listed" ? (
                        <Badge variant={MODE_BADGE[flag.mode]}>{flag.logins.length}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing({ key: flag.key, input: inputOf(flag) })}
                      >
                        {t.editButton}
                      </Button>
                      <Button
                        variant="destructive-outline"
                        size="sm"
                        onClick={() => setDeleting(flag)}
                      >
                        {strings.actions.delete}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      {editing ? (
        <FlagEditor
          key={editing.key ?? "new"}
          editing={editing}
          pending={save.isPending}
          onCancel={() => setEditing(null)}
          onSave={(key, input) => save.mutate({ key, input, isNew: editing.key === null })}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.deleteTitle(deleting?.key ?? "")}
        description={t.deleteBody}
        confirmLabel={strings.actions.delete}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

function FlagEditor({
  editing,
  pending,
  onCancel,
  onSave,
}: {
  readonly editing: Editing;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (key: string, input: FeatureFlagInput) => void;
}) {
  const id = useId();
  const [key, setKey] = useState(editing.key ?? "");
  const [description, setDescription] = useState(editing.input.description);
  const [mode, setMode] = useState(editing.input.mode);
  const [logins, setLogins] = useState(editing.input.logins.join("\n"));
  const f = t.fields;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={editing.key ? t.edit(editing.key) : t.new}
      description={t.description}
      confirmLabel={strings.save}
      pending={pending}
      confirmDisabled={!key.trim()}
      onConfirm={() =>
        onSave(key.trim(), { description: description.trim(), mode, logins: parseLogins(logins) })
      }
    >
      <div className="mt-2 grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-key`}>{f.key}</Label>
          <Input
            id={`${id}-key`}
            required
            disabled={editing.key !== null}
            pattern="[a-z][a-z0-9_.\-]{0,63}"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            aria-describedby={`${id}-key-hint`}
          />
          <p id={`${id}-key-hint`} className="text-xs text-muted-foreground">
            {f.keyHint}
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-description`}>{f.description}</Label>
          <Input
            id={`${id}-description`}
            maxLength={500}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-mode`}>{f.mode}</Label>
          <NativeSelect
            id={`${id}-mode`}
            value={mode}
            onChange={(event) => setMode(event.target.value as FlagMode)}
          >
            {MODES.map((value) => (
              <option key={value} value={value}>
                {t.modes[value]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-logins`}>{f.logins}</Label>
          <Textarea
            id={`${id}-logins`}
            value={logins}
            onChange={(event) => setLogins(event.target.value)}
            aria-describedby={`${id}-logins-hint`}
          />
          <p id={`${id}-logins-hint`} className="text-xs text-muted-foreground">
            {f.loginsHint}
          </p>
        </div>
      </div>
    </ConfirmDialog>
  );
}
