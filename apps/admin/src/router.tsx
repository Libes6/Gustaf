import { createRootRouteWithContext, createRoute, createRouter } from "@tanstack/react-router";

import type { Me } from "./api/types";
import { EmptyState } from "./components/states";
import { AnnouncementsPage } from "./pages/AnnouncementsPage";
import { AiUsagePage } from "./pages/AiUsagePage";
import { AppLayout } from "./pages/AppLayout";
import { AuditPage } from "./pages/AuditPage";
import { DevicesPage } from "./pages/DevicesPage";
import { FeatureFlagsPage } from "./pages/FeatureFlagsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { RelayPage } from "./pages/RelayPage";
import { ReleasesPage } from "./pages/ReleasesPage";
import { SystemPage } from "./pages/SystemPage";
import { ReportDetailPage } from "./pages/ReportDetailPage";
import { ReportsPage } from "./pages/ReportsPage";
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

const aiUsageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-usage",
  component: AiUsagePage,
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

const reportsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reports",
  component: ReportsPage,
});

const reportRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reports/$reportId",
  component: ReportDetailPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    overviewRoute,
    usersRoute,
    userRoute,
    devicesRoute,
    aiUsageRoute,
    auditRoute,
    announcementsRoute,
    versionsRoute,
    flagsRoute,
    relayRoute,
    systemRoute,
    releasesRoute,
    reportsRoute,
    reportRoute,
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
