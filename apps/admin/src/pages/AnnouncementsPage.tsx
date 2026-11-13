import { PlusIcon } from "lucide-react";
import { useId, useState } from "react";

import { api } from "../api/instance";
import { useAdminAction, useAnnouncements } from "../api/queries";
import type {
  Announcement,
  AnnouncementInput,
  AnnouncementLevel,
  ClientTarget,
} from "../api/types";
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
import {
  EMPTY_ANNOUNCEMENT,
  fromDateTimeLocal,
  optional,
  toDateTimeLocal,
} from "../lib/client-config";
import { formatDateTime } from "../lib/format";
import { strings } from "../strings";
import { PageTitle } from "./AppLayout";

const t = strings.announcements;
const LEVELS: ReadonlyArray<AnnouncementLevel> = ["info", "warning", "critical"];
const TARGETS: ReadonlyArray<ClientTarget> = ["all", "desktop", "mobile"];
const LEVEL_BADGE = { info: "primary", warning: "warning", critical: "error" } as const;

type Editing = { readonly id: string | null; readonly input: AnnouncementInput };

function inputOf(row: Announcement): AnnouncementInput {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = row;
  return input;
}

function schedule(row: Announcement) {
  const from = row.startsAt ? formatDateTime(row.startsAt) : null;
  const until = row.endsAt ? formatDateTime(row.endsAt) : null;
  if (from && until) return t.range(from, until);
  if (from) return t.from(from);
  if (until) return t.until(until);
  return t.always;
}

export function AnnouncementsPage() {
  const result = useAnnouncements();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Announcement | null>(null);
  const save = useAdminAction(
    ({ id, input }: Editing) =>
      id ? api.updateAnnouncement(id, input) : api.createAnnouncement(input),
    () => strings.saved,
    () => setEditing(null),
  );
  const remove = useAdminAction(
    (row: Announcement) => api.deleteAnnouncement(row.id),
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
        <Button onClick={() => setEditing({ id: null, input: EMPTY_ANNOUNCEMENT })}>
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
                <TableHead>{t.columns.text}</TableHead>
                <TableHead>{t.columns.level}</TableHead>
                <TableHead className="max-sm:hidden">{t.columns.target}</TableHead>
                <TableHead className="max-md:hidden">{t.columns.when}</TableHead>
                <TableHead>{t.columns.status}</TableHead>
                <TableHead>
                  <span className="sr-only">{strings.users.actions}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.data.items.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="max-w-72">
                    <p className="truncate font-medium">{row.textEn}</p>
                    <p className="truncate text-muted-foreground">{row.textRu}</p>
                  </TableCell>
                  <TableCell>
                    <Badge variant={LEVEL_BADGE[row.level]}>{t.levels[row.level]}</Badge>
                  </TableCell>
                  <TableCell className="max-sm:hidden">
                    {t.targets[row.target]}
                    {row.minVersion || row.maxVersion ? (
                      <p className="text-muted-foreground">
                        {t.versions(row.minVersion, row.maxVersion)}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-md:hidden">
                    {schedule(row)}
                  </TableCell>
                  <TableCell>
                    {row.active ? (
                      <Badge variant="success">{t.active}</Badge>
                    ) : (
                      <Badge variant="outline">{t.disabled}</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={save.isPending}
                        onClick={() =>
                          save.mutate({
                            id: row.id,
                            input: { ...inputOf(row), active: !row.active },
                          })
                        }
                      >
                        {row.active ? t.disable : t.enable}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing({ id: row.id, input: inputOf(row) })}
                      >
                        {strings.flags.editButton}
                      </Button>
                      <Button
                        variant="destructive-outline"
                        size="sm"
                        onClick={() => setDeleting(row)}
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
        <AnnouncementEditor
          key={editing.id ?? "new"}
          editing={editing}
          pending={save.isPending}
          onCancel={() => setEditing(null)}
          onSave={(input) => save.mutate({ id: editing.id, input })}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.deleteTitle}
        description={t.deleteBody}
        confirmLabel={strings.actions.delete}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </>
  );
}

function AnnouncementEditor({
  editing,
  pending,
  onCancel,
  onSave,
}: {
  readonly editing: Editing;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onSave: (input: AnnouncementInput) => void;
}) {
  const id = useId();
  const [input, setInput] = useState(editing.input);
  const set = <K extends keyof AnnouncementInput>(key: K, value: AnnouncementInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  const field = (name: string) => `${id}-${name}`;
  const f = t.fields;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={editing.id ? t.edit : t.new}
      description={t.description}
      confirmLabel={strings.save}
      pending={pending}
      confirmDisabled={!input.textEn.trim() || !input.textRu.trim()}
      onConfirm={() => onSave(input)}
    >
      <div className="mt-2 grid max-h-[60dvh] gap-3 overflow-y-auto pr-1">
        <div className="grid gap-1.5">
          <Label htmlFor={field("en")}>{f.textEn}</Label>
          <Textarea
            id={field("en")}
            required
            maxLength={1000}
            value={input.textEn}
            onChange={(event) => set("textEn", event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={field("ru")}>{f.textRu}</Label>
          <Textarea
            id={field("ru")}
            required
            maxLength={1000}
            value={input.textRu}
            onChange={(event) => set("textRu", event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={field("level")}>{f.level}</Label>
            <NativeSelect
              id={field("level")}
              value={input.level}
              onChange={(event) => set("level", event.target.value as AnnouncementLevel)}
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {t.levels[level]}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={field("target")}>{f.target}</Label>
            <NativeSelect
              id={field("target")}
              value={input.target}
              onChange={(event) => set("target", event.target.value as ClientTarget)}
            >
              {TARGETS.map((target) => (
                <option key={target} value={target}>
                  {t.targets[target]}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={field("link")}>{f.link}</Label>
          <Input
            id={field("link")}
            type="url"
            placeholder="https://"
            value={input.link ?? ""}
            onChange={(event) => set("link", optional(event.target.value))}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={field("min")}>{f.minVersion}</Label>
            <Input
              id={field("min")}
              placeholder="1.0.0"
              value={input.minVersion ?? ""}
              onChange={(event) => set("minVersion", optional(event.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={field("max")}>{f.maxVersion}</Label>
            <Input
              id={field("max")}
              placeholder="2.0.0"
              value={input.maxVersion ?? ""}
              onChange={(event) => set("maxVersion", optional(event.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={field("start")}>{f.startsAt}</Label>
            <Input
              id={field("start")}
              type="datetime-local"
              value={toDateTimeLocal(input.startsAt)}
              onChange={(event) => set("startsAt", fromDateTimeLocal(event.target.value))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={field("end")}>{f.endsAt}</Label>
            <Input
              id={field("end")}
              type="datetime-local"
              value={toDateTimeLocal(input.endsAt)}
              onChange={(event) => set("endsAt", fromDateTimeLocal(event.target.value))}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={input.active}
            onChange={(event) => set("active", event.target.checked)}
          />
          {f.active}
        </label>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t.preview}</p>
          <AnnouncementPreview input={input} text={input.textEn} />
          <AnnouncementPreview input={input} text={input.textRu} />
        </div>
      </div>
    </ConfirmDialog>
  );
}

const PREVIEW_TONE = {
  info: "border-primary/32 bg-primary/8",
  warning: "border-warning/32 bg-warning/8",
  critical: "border-destructive/32 bg-destructive/8",
} as const;

function AnnouncementPreview({
  input,
  text,
}: {
  readonly input: AnnouncementInput;
  readonly text: string;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 text-sm ${PREVIEW_TONE[input.level]}`}>
      <span className="whitespace-pre-wrap">{text || "…"}</span>
      {input.link ? (
        <span className="ms-2 font-medium underline underline-offset-2">{t.learnMore}</span>
      ) : null}
    </div>
  );
}
