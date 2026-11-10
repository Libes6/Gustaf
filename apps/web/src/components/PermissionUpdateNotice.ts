import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "../state/presentation";
import { environmentSession } from "../state/session";
import { toastManager } from "./ui/toast";

import { getClientSettings } from "../hooks/useSettings";
import { translate, type MessageKey } from "../i18n";

const tNow = (key: MessageKey) => translate(getClientSettings().uiLanguage, key);

interface LegacyPermissionEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** Environments whose settled session still carries pre-scope permissions. */
const legacyPermissionEnvironmentsAtom = Atom.make((get) =>
  get(environmentSummaries.identitiesAtom).filter(({ environmentId }) => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return (
      session._tag === "Success" && !session.waiting && sessionHasLegacyPermissions(session.value)
    );
  }),
).pipe(Atom.withLabel("web-legacy-permission-environments"));

const dismissalKey = (environmentId: EnvironmentId) =>
  `t3code:permission-update:v1:${environmentId}`;

function showPermissionNotice(
  router: AnyRouter,
  { environmentId, label }: LegacyPermissionEnvironment,
) {
  const key = dismissalKey(environmentId);
  const persistDismissal = () => {
    try {
      setLocalStorageItem(key, true, Schema.Boolean);
    } catch {}
  };
  const dismiss = () => {
    persistDismissal();
    toastManager.close(id);
  };
  const id = toastManager.add({
    title: tNow("shell.toasts.permissionsChanged").replace("{label}", label),
    description: tNow("shell.toasts.oldPermissions"),
    timeout: 0,
    onClose: persistDismissal,
    actionProps: {
      children: tNow("shell.toasts.openSharingAccess"),
      onClick: () => {
        dismiss();
        void router.navigate({ to: "/settings/access" });
      },
    },
    data: {
      actionLayout: "stacked-end",
      secondaryActionProps: { children: tNow("shell.toasts.dismiss"), onClick: dismiss },
      secondaryActionVariant: "ghost",
    },
  });
}

/** Asks once per environment, until dismissed, to re-pair a connection that predates scoped permissions. */
export function startPermissionUpdateNotices(router: AnyRouter): () => void {
  const shown = new Set<EnvironmentId>();
  return appAtomRegistry.subscribe(
    legacyPermissionEnvironmentsAtom,
    (environments) => {
      for (const environment of environments) {
        if (shown.has(environment.environmentId)) continue;
        try {
          if (getLocalStorageItem(dismissalKey(environment.environmentId), Schema.Boolean))
            continue;
        } catch {}
        shown.add(environment.environmentId);
        showPermissionNotice(router, environment);
      }
    },
    { immediate: true },
  );
}
