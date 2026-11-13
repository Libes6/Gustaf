import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";

import type { Me } from "./api/types";
import { EmptyState } from "./components/states";
import { AnnouncementsPage } from "./pages/AnnouncementsPage";
import { AppLayout } from "./pages/AppLayout";
import { AuditPage } from "./pages/AuditPage";
import { DevicesPage } from "./pages/DevicesPage";
import { FeatureFlagsPage } from "./pages/FeatureFlagsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { UserDetailPage } from "./pages/UserDetailPage";
import { UsersPage } from "./pages/UsersPage";
import { VersionsPage } from "./pages/VersionsPage";
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

const announcementsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/announcements",
  component: AnnouncementsPage,
});

const versionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/versions",
  component: VersionsPage,
});

const flagsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/flags",
  component: FeatureFlagsPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    overviewRoute,
    usersRoute,
    userRoute,
    devicesRoute,
    auditRoute,
    announcementsRoute,
    versionsRoute,
    flagsRoute,
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
