import { T3CHAT_PLAN_TUNNEL_LIMITS } from "@t3tools/contracts/relay";
import { TriangleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { ManagedTunnelUpgrade } from "../../cloud/managedRelayState";
import { useT } from "../../useUiLanguage";
import { cn } from "../../lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

// Above this, one slot per tunnel is too thin to read, so the bar fills instead.
const MAX_SEGMENTS = 10;

export const T3CHAT_SUBSCRIPTION_URL = "https://t3.chat/settings/subscription";

export function tunnelUpgradeCopy(
  upgrade: Exclude<ManagedTunnelUpgrade, null>,
  t: ReturnType<typeof useT>,
): string {
  const { pro, premier } = T3CHAT_PLAN_TUNNEL_LIMITS;
  switch (upgrade) {
    case "link":
      return t("misc.tunnelUsage.upgradeLink")
        .replace("{pro}", String(pro))
        .replace("{premier}", String(premier));
    case "pro":
      return t("misc.tunnelUsage.upgradePro")
        .replace("{pro}", String(pro))
        .replace("{premier}", String(premier));
    case "premier":
      return t("misc.tunnelUsage.upgradePremier").replace("{premier}", String(premier));
  }
}

/** "2 of 3 tunnels in use" with one bar slot per tunnel. */
export function TunnelUsageMeter({
  used,
  limit,
  action,
  className,
}: {
  readonly used: number;
  readonly limit: number;
  readonly action?: ReactNode;
  readonly className?: string;
}) {
  const t = useT();
  const full = used >= limit;
  const fill = full ? "bg-warning" : "bg-foreground/72";
  const usageLabel = t("misc.tunnelUsage.tunnelsInUse")
    .replace("{used}", String(used))
    .replace("{limit}", String(limit));
  return (
    <div className={cn("flex max-w-sm flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className={cn("tabular-nums", full ? "text-warning-foreground" : "text-foreground")}>
          {usageLabel}
        </span>
        {action}
      </div>
      <div
        role="meter"
        aria-label={t("misc.tunnelUsage.meterAria")}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        className="flex h-1.5 gap-1"
      >
        {limit <= MAX_SEGMENTS ? (
          Array.from({ length: limit }, (_, index) => (
            <span
              key={index}
              className={cn("flex-1 rounded-full", index < used ? fill : "bg-muted")}
            />
          ))
        ) : (
          <span className="flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full rounded-full", fill)}
              style={{ width: `${Math.min(100, (used / limit) * 100)}%` }}
            />
          </span>
        )}
      </div>
    </div>
  );
}

/** Shown when the relay refuses a new tunnel because the account is at its cap. */
export function TunnelLimitAlert({
  upgrade,
  onLinkT3Chat,
  onManageTunnels,
}: {
  readonly upgrade: ManagedTunnelUpgrade;
  readonly onLinkT3Chat: (() => void) | null;
  readonly onManageTunnels: (() => void) | null;
}) {
  const t = useT();
  const action =
    upgrade === "link" && onLinkT3Chat ? (
      <Button size="sm" onClick={onLinkT3Chat}>
        {t("misc.tunnelUsage.linkT3Chat")}
      </Button>
    ) : upgrade === "pro" || upgrade === "premier" ? (
      <Button
        size="sm"
        render={<a href={T3CHAT_SUBSCRIPTION_URL} target="_blank" rel="noopener noreferrer" />}
      >
        {t("misc.tunnelUsage.upgradeOnT3Chat")}
      </Button>
    ) : onManageTunnels ? (
      <Button size="sm" variant="outline" onClick={onManageTunnels}>
        {t("misc.tunnelUsage.manageTunnels")}
      </Button>
    ) : null;
  const description =
    upgrade === "link"
      ? t("misc.tunnelUsage.outOfTunnelsDescriptionLink")
      : upgrade
        ? t("misc.tunnelUsage.outOfTunnelsDescriptionUpgrade")
        : t("misc.tunnelUsage.outOfTunnelsDescriptionDeregister");
  return (
    <Alert variant="warning">
      <TriangleAlertIcon />
      <AlertTitle>{t("misc.tunnelUsage.outOfTunnelsTitle")}</AlertTitle>
      <AlertDescription>{description}</AlertDescription>
      {action ? <AlertAction>{action}</AlertAction> : null}
    </Alert>
  );
}
