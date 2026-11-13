import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";

import type { Me } from "./api/types";
import { EmptyState } from "./components/states";
import { AppLayout } from "./pages/AppLayout";
import { AuditPage } from "./pages/AuditPage";
import { DevicesPage } from "./pages/DevicesPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RelayPage } from "./pages/RelayPage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { SystemPage } from "./pages/SystemPage";
import { UserDetailPage } from "./pages/UserDetailPage";
import { UsersPage } from "./pages/UsersPage";
import { strings } from "./strings";

interface RouterContext {
  readonly me: Me;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: AppLayout,
  notFoundComponent: () => <EmptyState message={strings.errors.notFound} />,
});

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: OverviewPage,
});

const usersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users",
  component: UsersPage,
});

const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/users/$userId",
  component: UserDetailPage,
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  component: DevicesPage,
});

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  component: AuditPage,
});

const relayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/relay",
  component: RelayPage,
});

const systemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/system",
  component: SystemPage,
});

const releasesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/releases",
  component: ReleasesPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    overviewRoute,
    usersRoute,
    userRoute,
    devicesRoute,
    auditRoute,
    relayRoute,
    systemRoute,
    releasesRoute,
  ]),
  // The real value arrives through RouterProvider once /v1/me confirms an admin.
  context: { me: undefined! },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
