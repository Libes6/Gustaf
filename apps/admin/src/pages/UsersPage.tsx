import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useUsers } from "../api/queries";
import { Pager } from "../components/pager";
import { RoleBadge, StatusBadge } from "../components/role-badges";
import { SearchForm } from "../components/search-form";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { UserAvatar } from "../components/user-avatar";
import { formatCount, formatDateTime } from "../lib/format";
import { strings } from "../strings";
import { PageTitle, useMeContext } from "./AppLayout";

export function UsersPage() {
  const me = useMeContext();
  const [query, setQuery] = useState("");
  const list = useUsers(query);
  const { query: result } = list;
  const columns = strings.users.columns;

  return (
    <>
      <PageTitle>{strings.users.title}</PageTitle>
      <div className="mb-4 flex">
        <SearchForm
          label={strings.users.searchLabel}
          placeholder={strings.users.searchPlaceholder}
          defaultValue={query}
          onSearch={setQuery}
        />
      </div>
      <Card className="p-0">
        {result.isPending ? (
          <LoadingState />
        ) : result.isError ? (
          <ErrorState error={result.error} onRetry={() => void result.refetch()} />
        ) : result.data.items.length === 0 ? (
          <EmptyState message={strings.users.empty} />
        ) : (
          <>
            <Table aria-busy={result.isFetching}>
              <TableHeader>
                <TableRow>
                  <TableHead>{columns.user}</TableHead>
                  <TableHead>{columns.role}</TableHead>
                  <TableHead>{columns.status}</TableHead>
                  <TableHead className="text-right max-md:hidden">{columns.devices}</TableHead>
                  <TableHead className="text-right max-md:hidden">{columns.sessions}</TableHead>
                  <TableHead className="max-lg:hidden">{columns.created}</TableHead>
                  <TableHead className="max-sm:hidden">{columns.lastSeen}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.items.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <UserAvatar name={user.name} image={user.image} />
                        <div className="min-w-0">
                          <Link
                            to="/users/$userId"
                            params={{ userId: user.id }}
                            aria-label={strings.users.open(user.name)}
                            className="block max-w-56 truncate font-medium outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                          >
                            {user.name}
                          </Link>
                          <span className="block max-w-56 truncate text-xs text-muted-foreground">
                            {user.githubLogin ? `@${user.githubLogin}` : user.email}
                          </span>
                        </div>
                        {user.id === me.id ? (
                          <Badge variant="outline">{strings.common.you}</Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge banned={user.banned} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums max-md:hidden">
                      {formatCount(user.deviceCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums max-md:hidden">
                      {formatCount(user.sessionCount)}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-lg:hidden">
                      {formatDateTime(user.createdAt)}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-sm:hidden">
                      {formatDateTime(user.lastSeenAt)}
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
    </>
  );
}
