import { Link, Outlet, useRouteContext } from "@tanstack/react-router";
import { LogOutIcon, ShieldIcon } from "lucide-react";

import { useSignOut } from "../api/queries";
import { Button } from "../components/ui/button";
import { strings } from "../strings";

const NAV = [
  { to: "/", label: strings.nav.overview, exact: true },
  { to: "/users", label: strings.nav.users, exact: false },
  { to: "/devices", label: strings.nav.devices, exact: false },
  { to: "/relay", label: strings.nav.relay, exact: false },
  { to: "/system", label: strings.nav.system, exact: false },
  { to: "/releases", label: strings.nav.releases, exact: false },
  { to: "/audit", label: strings.nav.audit, exact: false },
] as const;

export function useMeContext() {
  return useRouteContext({ from: "__root__", select: (context) => context.me });
}

export function AppLayout() {
  const me = useMeContext();
  const signOut = useSignOut();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 px-4 pt-[env(safe-area-inset-top)] sm:flex-nowrap">
          <div className="flex h-14 items-center gap-2 font-semibold">
            <ShieldIcon aria-hidden className="size-4 text-primary" />
            <span>{strings.appName}</span>
          </div>
          <nav
            aria-label={strings.nav.label}
            className="order-last -mx-4 flex w-[calc(100%+2rem)] gap-1 overflow-x-auto px-3 pb-2 sm:order-none sm:mx-0 sm:w-auto sm:p-0"
          >
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className="rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:bg-accent data-[status=active]:font-medium data-[status=active]:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-2">
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
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
        <Outlet />
      </main>
    </div>
  );
}

export function PageTitle({ children }: { readonly children: string }) {
  return <h1 className="mb-4 text-xl font-semibold tracking-tight">{children}</h1>;
}
