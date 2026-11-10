import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import {
  AUTH_SCOPE_OPTIONS,
  sessionPermissionsUnavailableMessage,
} from "@t3tools/shared/authScopeOptions";
import { useEnvironmentSessionState } from "~/state/session";
import { useT } from "../../useUiLanguage";

export function SessionPermissions({
  environmentId,
  connected,
  routeContext = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly routeContext?: boolean;
}) {
  const t = useT();
  const session = useEnvironmentSessionState(environmentId);
  return connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
    <div className="space-y-3 py-3 text-xs">
      <p className="text-muted-foreground">
        {routeContext
          ? t("settingsD.sessionPermissions.routePermissions")
          : t("settingsD.sessionPermissions.connectionPermissions")}
      </p>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
          <li key={scope} className="flex items-start justify-between gap-3">
            <span>{title}</span>
            <span className="shrink-0 text-muted-foreground">
              {sessionGrantsScope(session.data!, scope)
                ? t("settingsD.sessionPermissions.allowed")
                : t("settingsD.sessionPermissions.notGranted")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-3 text-xs text-muted-foreground">
      {sessionPermissionsUnavailableMessage({
        connected,
        failed: session.hasError,
        rejected: !session.hasError && !session.isPending && session.data?.authenticated === false,
      })}
    </p>
  );
}
