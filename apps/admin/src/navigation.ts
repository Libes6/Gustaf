import {
  BotIcon,
  FileClockIcon,
  FlagIcon,
  InboxIcon,
  LayoutDashboardIcon,
  MegaphoneIcon,
  PackageIcon,
  RadioTowerIcon,
  ServerIcon,
  SmartphoneIcon,
  TagIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { strings } from "./strings";

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: LucideIcon;
}

export interface NavGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly [NavItem, ...NavItem[]];
}

export const NAV_GROUPS = [
  {
    id: "overview",
    label: strings.nav.overview,
    items: [{ to: "/", label: strings.nav.overview, icon: LayoutDashboardIcon }],
  },
  {
    id: "accounts",
    label: strings.nav.groups.accounts,
    items: [
      { to: "/users", label: strings.nav.users, icon: UsersIcon },
      { to: "/devices", label: strings.nav.devices, icon: SmartphoneIcon },
    ],
  },
  {
    id: "product",
    label: strings.nav.groups.product,
    items: [
      { to: "/announcements", label: strings.nav.announcements, icon: MegaphoneIcon },
      { to: "/versions", label: strings.nav.versions, icon: TagIcon },
      { to: "/releases", label: strings.nav.releases, icon: PackageIcon },
      { to: "/flags", label: strings.nav.flags, icon: FlagIcon },
    ],
  },
  {
    id: "infrastructure",
    label: strings.nav.groups.infrastructure,
    items: [
      { to: "/relay", label: strings.nav.relay, icon: RadioTowerIcon },
      { to: "/system", label: strings.nav.system, icon: ServerIcon },
      { to: "/ai-usage", label: strings.nav.aiUsage, icon: BotIcon },
    ],
  },
  {
    id: "control",
    label: strings.nav.groups.control,
    items: [
      { to: "/reports", label: strings.nav.reports, icon: InboxIcon },
      { to: "/audit", label: strings.nav.audit, icon: FileClockIcon },
    ],
  },
] as const satisfies readonly NavGroup[];

export const REPORTS_PATH = "/reports";

function matchesNavItem(item: Pick<NavItem, "to">, pathname: string): boolean {
  if (item.to === "/") return pathname === "/";
  return pathname === item.to || pathname.startsWith(`${item.to}/`);
}

export interface ActiveNav {
  readonly group: NavGroup;
  readonly item: NavItem;
  /** True on a detail route below the item, such as /users/123. */
  readonly nested: boolean;
}

export function resolveActiveNav(
  pathname: string,
  groups: readonly NavGroup[] = NAV_GROUPS,
): ActiveNav | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  for (const group of groups) {
    for (const item of group.items) {
      if (matchesNavItem(item, path)) return { group, item, nested: path !== item.to };
    }
  }
  return null;
}
