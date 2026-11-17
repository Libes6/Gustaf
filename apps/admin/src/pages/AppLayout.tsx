import { Link, Outlet, useLocation, useRouteContext } from "@tanstack/react-router";
import { ChevronDownIcon, LogOutIcon, ShieldIcon } from "lucide-react";
import { useId, useState } from "react";

import { useReportCounts, useSignOut } from "../api/queries";
import { Button } from "../components/ui/button";
import {
  type ActiveNav,
  type NavGroup,
  NAV_GROUPS,
  REPORTS_PATH,
  resolveActiveNav,
} from "../navigation";
import { strings } from "../strings";

export function useMeContext() {
  return useRouteContext({ from: "__root__", select: (context) => context.me });
}

export function AppLayout() {
  const me = useMeContext();
  const signOut = useSignOut();
  const newReports = useReportCounts().data?.new ?? 0;
  const pathname = useLocation({ select: (location) => location.pathname });
  const active = resolveActiveNav(pathname);
  const showLocalNav = active !== null && active.group.items.length > 1;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b bg-background pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldIcon aria-hidden className="size-4 text-primary" />
            <span>{strings.appName}</span>
          </div>
          <div className="ms-auto flex min-w-0 items-center gap-2">
            <span className="hidden max-w-48 truncate text-sm text-muted-foreground md:inline">
              {me.name}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => signOut.mutate()}
              disabled={signOut.isPending}
            >
              <LogOutIcon aria-hidden />
              {strings.nav.signOut}
            </Button>
          </div>
        </div>
        <nav aria-label={strings.nav.label} className="mx-auto max-w-6xl px-4">
          <ul className="-mx-4 flex gap-1 overflow-x-auto px-2 sm:mx-0 sm:gap-4 sm:px-0">
            {NAV_GROUPS.map((group) => (
              <li key={group.id} className="shrink-0">
                <GroupTab
                  group={group}
                  current={active?.group.id === group.id}
                  badge={group.items.some((item) => item.to === REPORTS_PATH) ? newReports : 0}
                />
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] lg:flex lg:items-start lg:gap-8">
        {showLocalNav ? (
          <LocalNav key={active.group.id} active={active} newReports={newReports} />
        ) : null}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function GroupTab({
  group,
  current,
  badge,
}: {
  readonly group: NavGroup;
  readonly current: boolean;
  readonly badge: number;
}) {
  return (
    <Link
      to={group.items[0].to}
      activeOptions={{ exact: true }}
      aria-current={current ? "true" : undefined}
      data-current={current || undefined}
      className="relative flex h-11 items-center px-2 text-sm whitespace-nowrap text-muted-foreground outline-none after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-current:font-medium data-current:text-foreground data-current:after:bg-foreground sm:px-0 sm:after:inset-x-0"
    >
      {group.label}
      <UnreadBadge count={badge} />
    </Link>
  );
}

function LocalNav({
  active,
  newReports,
}: {
  readonly active: ActiveNav;
  readonly newReports: number;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <nav
      aria-label={strings.nav.sectionLabel(active.group.label)}
      className="mb-5 rounded-lg border bg-card lg:sticky lg:top-[calc(7.75rem+env(safe-area-inset-top))] lg:mb-0 lg:w-52 lg:shrink-0 lg:border-0 lg:bg-transparent"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
      >
        <active.item.icon aria-hidden className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">{active.group.label}</span>
        <span aria-hidden className="text-muted-foreground">
          /
        </span>
        <span className="font-medium">{active.item.label}</span>
        <ChevronDownIcon
          aria-hidden
          className={`ms-auto size-4 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div id={listId} className={open ? "border-t p-1.5 lg:border-0 lg:p-0" : "hidden lg:block"}>
        <p className="hidden px-3 pb-2 text-xs font-medium text-muted-foreground lg:block">
          {active.group.label}
        </p>
        <ul className="flex flex-col gap-0.5">
          {active.group.items.map((item) => {
            const current = item.to === active.item.to;
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: true }}
                  onClick={() => setOpen(false)}
                  aria-current={current ? (active.nested ? "true" : "page") : undefined}
                  data-current={current || undefined}
                  className="flex items-center gap-2.5 rounded-md border border-transparent px-3 py-1.5 text-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-current:border-border data-current:bg-card data-current:font-medium data-current:text-foreground"
                >
                  <item.icon aria-hidden className="size-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {item.to === REPORTS_PATH ? <UnreadBadge count={newReports} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

function UnreadBadge({ count }: { readonly count: number }) {
  if (count <= 0) return null;
  return (
    <>
      <span
        aria-hidden
        className="ms-1.5 rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground tabular-nums"
      >
        {count}
      </span>
      <span className="sr-only">{strings.nav.unreadReports(count)}</span>
    </>
  );
}
