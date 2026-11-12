import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useId, useState } from "react";
import type * as React from "react";

import { api } from "../api/instance";
import { useAdminAction, useUser } from "../api/queries";
import type { AdminUserDetail } from "../api/types";
import { RoleBadge, StatusBadge } from "../components/role-badges";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardTitle } from "../components/ui/card";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Label, Textarea } from "../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { UserAvatar } from "../components/user-avatar";
import { formatDateTime } from "../lib/format";
import { availableUserActions, normalizeBanReason, otherRole, type UserAction } from "../lib/rules";
import { strings } from "../strings";
import { useMeContext } from "./AppLayout";

export function UserDetailPage() {
  const { userId } = useParams({ from: "/users/$userId" });
  const user = useUser(userId);
  return (
    <>
      <Link
        to="/users"
        className="mb-4 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        {strings.users.back}
      </Link>
      {user.isPending ? (
        <LoadingState />
      ) : user.isError ? (
        <ErrorState error={user.error} onRetry={() => void user.refetch()} />
      ) : (
        <UserDetail user={user.data} />
      )}
    </>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 py-1.5 text-sm sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere sm:text-right">{children}</dd>
    </div>
  );
}

function UserDetail({ user }: { readonly user: AdminUserDetail }) {
  const me = useMeContext();
  const actions = availableUserActions(me.id, user);
  const isSelf = user.id === me.id;
  const [dialog, setDialog] = useState<UserAction | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar name={user.name} image={user.image} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{user.name}</h1>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <RoleBadge role={user.role} />
            <StatusBadge banned={user.banned} />
            {isSelf ? <Badge variant="outline">{strings.common.you}</Badge> : null}
          </div>
        </div>
      </div>

      <Card>
        <CardTitle>{strings.users.actions}</CardTitle>
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map(({ action, enabled }) => (
            <Button
              key={action}
              variant={action === "delete" || action === "ban" ? "destructive-outline" : "outline"}
              disabled={!enabled}
              onClick={() => setDialog(action)}
            >
              {action === "change-role"
                ? `${strings.actions.changeRole}: ${strings.roles[otherRole(user.role)]}`
                : ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
        {isSelf ? (
          <p className="mt-2 text-xs text-muted-foreground">{strings.users.selfHint}</p>
        ) : null}
      </Card>

      <Card>
        <CardTitle>{strings.users.profile}</CardTitle>
        <dl className="mt-2 divide-y">
          <Field label={strings.users.email}>{user.email}</Field>
          <Field label={strings.users.github}>
            {user.githubLogin ? `@${user.githubLogin}` : strings.common.none}
          </Field>
          <Field label={strings.users.columns.created}>{formatDateTime(user.createdAt)}</Field>
          <Field label={strings.users.columns.lastSeen}>{formatDateTime(user.lastSeenAt)}</Field>
          {user.banned ? (
            <Field label={strings.users.banReason}>{user.banReason ?? strings.common.none}</Field>
          ) : null}
        </dl>
      </Card>

      <Card className="p-0">
        <CardTitle className="px-4 pt-4">{strings.users.devices}</CardTitle>
        {user.devices.length === 0 ? (
          <EmptyState message={strings.users.devicesEmpty} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{strings.devices.columns.device}</TableHead>
                <TableHead>{strings.devices.columns.kind}</TableHead>
                <TableHead>{strings.devices.columns.lastSeen}</TableHead>
                <TableHead className="max-sm:hidden">{strings.devices.columns.created}</TableHead>
                <TableHead>{strings.devices.columns.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {user.devices.map((device) => (
                <TableRow key={device.id}>
                  <TableCell className="font-medium">{device.name}</TableCell>
                  <TableCell>{strings.kinds[device.kind]}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(device.lastSeenAt)}
                  </TableCell>
                  <TableCell className="text-muted-foreground max-sm:hidden">
                    {formatDateTime(device.createdAt)}
                  </TableCell>
                  <TableCell>
                    {device.revokedAt ? (
                      <Badge variant="error">{strings.users.revoked}</Badge>
                    ) : (
                      <Badge variant="success">{strings.devices.active}</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card className="p-0">
        <CardTitle className="px-4 pt-4">{strings.users.sessions}</CardTitle>
        {user.sessions.length === 0 ? (
          <EmptyState message={strings.users.sessionsEmpty} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{strings.users.columns.created}</TableHead>
                <TableHead>{strings.users.expires}</TableHead>
                <TableHead>{strings.users.ipAddress}</TableHead>
                <TableHead className="max-md:hidden">{strings.users.userAgent}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {user.sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>{formatDateTime(session.createdAt)}</TableCell>
                  <TableCell>{formatDateTime(session.expiresAt)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {session.ipAddress ?? strings.common.none}
                  </TableCell>
                  <TableCell className="max-w-80 truncate text-xs text-muted-foreground max-md:hidden">
                    {session.userAgent ?? strings.common.none}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <UserActionDialogs user={user} open={dialog} onClose={() => setDialog(null)} />
    </div>
  );
}

const ACTION_LABELS: Record<UserAction, string> = {
  ban: strings.actions.ban,
  unban: strings.actions.unban,
  "revoke-sessions": strings.actions.revokeSessions,
  "change-role": strings.actions.changeRole,
  delete: strings.actions.delete,
};

function UserActionDialogs({
  user,
  open,
  onClose,
}: {
  readonly user: AdminUserDetail;
  readonly open: UserAction | null;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const name = user.name;
  const targetRole = otherRole(user.role);

  const ban = useAdminAction(
    (banReason: string) => api.banUser(user.id, banReason),
    () => strings.toasts.banned(name),
    () => setReason(""),
  );
  const unban = useAdminAction(
    () => api.unbanUser(user.id),
    () => strings.toasts.unbanned(name),
  );
  const revoke = useAdminAction(
    () => api.revokeSessions(user.id),
    () => strings.toasts.sessionsRevoked(name),
  );
  const changeRole = useAdminAction(
    () => api.changeRole(user.id, targetRole),
    () => strings.toasts.roleChanged(name, strings.roles[targetRole]),
  );
  const remove = useAdminAction(
    () => api.deleteUser(user.id),
    () => strings.toasts.deleted(name),
    () => void navigate({ to: "/users" }),
  );

  const close = (open: boolean) => {
    if (!open) onClose();
  };
  const done = { onSuccess: onClose };
  const validReason = normalizeBanReason(reason);

  return (
    <>
      <ConfirmDialog
        open={open === "ban"}
        onOpenChange={close}
        title={strings.confirm.banTitle(name)}
        description={strings.confirm.banBody}
        confirmLabel={strings.actions.ban}
        destructive
        pending={ban.isPending}
        confirmDisabled={validReason === null}
        onConfirm={() => validReason && ban.mutate(validReason, done)}
      >
        <div className="mt-2 flex flex-col gap-1.5">
          <Label htmlFor={reasonId}>{strings.confirm.banReasonLabel}</Label>
          <Textarea
            id={reasonId}
            value={reason}
            required
            minLength={3}
            maxLength={500}
            placeholder={strings.confirm.banReasonPlaceholder}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={open === "unban"}
        onOpenChange={close}
        title={strings.confirm.unbanTitle(name)}
        description={strings.confirm.unbanBody}
        confirmLabel={strings.actions.unban}
        pending={unban.isPending}
        onConfirm={() => unban.mutate(undefined, done)}
      />
      <ConfirmDialog
        open={open === "revoke-sessions"}
        onOpenChange={close}
        title={strings.confirm.revokeTitle(name)}
        description={strings.confirm.revokeBody}
        confirmLabel={strings.actions.revokeSessions}
        destructive
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(undefined, done)}
      />
      <ConfirmDialog
        open={open === "change-role"}
        onOpenChange={close}
        title={strings.confirm.roleTitle(name, strings.roles[targetRole])}
        description={strings.confirm.roleBody}
        confirmLabel={strings.actions.changeRole}
        pending={changeRole.isPending}
        onConfirm={() => changeRole.mutate(undefined, done)}
      />
      <ConfirmDialog
        open={open === "delete"}
        onOpenChange={close}
        title={strings.confirm.deleteTitle(name)}
        description={strings.confirm.deleteBody}
        confirmLabel={strings.actions.delete}
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined, done)}
      />
    </>
  );
}
