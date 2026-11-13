import type { NavigationState, PartialState } from "@react-navigation/native";
import { CommonActions, StackActions } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { parseRelayPairingLink } from "@t3tools/shared/relayTunnel";

import { t } from "../../i18n";
import { findLinkedRoute, updateLinkedRoute } from "../../lib/appLinking";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { leaveSettingsPage } from "../settings/settings-navigation";
import { workspaceHasColumns } from "../layout/workspace/workspace-selection-store";
import { pairEnvironment } from "../../state/use-remote-environment-registry";

export type DevAutoConnectAttempt =
  | { readonly pairingUrl: string; readonly status: "connecting" }
  | { readonly pairingUrl: string; readonly status: "failed"; readonly error: string | null };

/** The pairing the dev deep link started, so the form it opens can show its progress. */
export const devAutoConnectAttemptAtom = Atom.make<DevAutoConnectAttempt | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:dev-auto-connect-attempt"),
);

/**
 * What the form opened by `routePairingUrl` shows of the dev auto-connect. Editing or submitting
 * (`dismissed`) hides a failure, but a pairing still running keeps Connect busy, so the user
 * cannot start a second pairing beside it.
 */
export function autoConnectReport(
  attempt: DevAutoConnectAttempt | null,
  routePairingUrl: string,
  dismissed: boolean,
): { readonly connecting: boolean; readonly error: string | null } {
  if (attempt === null || routePairingUrl.length === 0 || attempt.pairingUrl !== routePairingUrl) {
    return { connecting: false, error: null };
  }
  if (attempt.status === "connecting") return { connecting: true, error: null };
  return { connecting: false, error: dismissed ? null : attempt.error };
}

// The pairing form is mounted both as a root sheet and inside the settings sheet.
const PAIRING_FORM_ROUTES = ["ConnectionsNew", "SettingsEnvironmentNew"];

function isAutoConnectFlag(value: unknown): boolean {
  return value === "1" || value === "true";
}

async function connect(pairingUrl: string) {
  const attempt: DevAutoConnectAttempt = { pairingUrl, status: "connecting" };
  appAtomRegistry.set(devAutoConnectAttemptAtom, attempt);
  const outcome = await pairEnvironment(pairingUrl);
  // A later link replaced or cleared this attempt; its result belongs to no open form.
  if (appAtomRegistry.get(devAutoConnectAttemptAtom) !== attempt) return;
  if (!outcome.ok) {
    appAtomRegistry.set(devAutoConnectAttemptAtom, {
      pairingUrl,
      status: "failed",
      error: outcome.error,
    });
    return;
  }
  whenRootNavigationReady(() => {
    // A newer link (with or without the flag) owns the form now.
    if (appAtomRegistry.get(devAutoConnectAttemptAtom) !== attempt) return;
    appAtomRegistry.set(devAutoConnectAttemptAtom, null);
    const current = rootNavigationRef.getCurrentRoute()?.name;
    if (current === undefined || !PAIRING_FORM_ROUTES.includes(current)) return;
    // Same exit as the form's own Connect: return to the opener, and on columns show the
    // new environment on Environments instead of an empty detail.
    if (!rootNavigationRef.canGoBack()) rootNavigationRef.dispatch(StackActions.replace("Home"));
    else leaveSettingsPage(rootNavigationRef, workspaceHasColumns(), "SettingsEnvironments");
  });
}

/**
 * `routeFor` makes a pairing an "Add route" to a saved environment, which skips the guard against
 * a pairing taking over that environment's id. Only in-app navigation may set it, never a link.
 */
export function withoutPairingTarget(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  return updateLinkedRoute(state, PAIRING_FORM_ROUTES, (route) => {
    if (route.params === undefined || !("routeFor" in route.params)) return route;
    const { routeFor: _routeFor, ...params } = route.params as { readonly routeFor?: unknown };
    return { ...route, params };
  });
}

/**
 * `connections/new?pairingUrl=…&autoConnect=1` (or `settings/environment-new?…`) pairs from the
 * link itself, so a remount of the form never pairs twice. Production builds ignore the flag so
 * a link can never pair with an attacker-chosen host.
 */
export function startDevAutoConnect(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (!__DEV__) return state;
  const route = findLinkedRoute(state, PAIRING_FORM_ROUTES);
  if (route === undefined) return state;
  const params = (route.params ?? {}) as {
    readonly autoConnect?: unknown;
    readonly pairingUrl?: unknown;
  };
  const pairingUrl = typeof params.pairingUrl === "string" ? params.pairingUrl.trim() : "";
  if (isAutoConnectFlag(params.autoConnect) && pairingUrl.length > 0) {
    void connect(pairingUrl);
  } else {
    // Only links put a pairing URL on the form, so a form opened by any other link starts
    // clean instead of showing an earlier auto-connect's failure for the same URL.
    appAtomRegistry.set(devAutoConnectAttemptAtom, null);
  }
  return state;
}

// Registered schemes (`gustaf-dev`, `gustaf-preview`) are rewritten; the parser accepts only `gustaf:`.
const RELAY_PAIR_PATH = /^(?:[a-z][\w+.-]*:\/\/)?\/?(?:[^/?#]+\/--\/)?relay-pair(?=[?#]|$)/i;

export function relayPairingLinkFromPath(path: string): string | null {
  const trimmed = path.trim();
  const match = RELAY_PAIR_PATH.exec(trimmed);
  if (!match) return null;
  const link = `gustaf://relay-pair${trimmed.slice(match[0].length)}`;
  return parseRelayPairingLink(link) === null ? null : link;
}

export function takeRelayPairingLink(
  state: PartialState<NavigationState> | undefined,
  path: string,
): PartialState<NavigationState> | undefined {
  const relayLink = relayPairingLinkFromPath(path);
  if (relayLink === null) return state;
  // The link's query fields become one opaque param that the form hands to `pairOverRelay`.
  const updated = updateLinkedRoute(state, PAIRING_FORM_ROUTES, (route) => ({
    ...route,
    params: { relayLink },
  }));
  if (findLinkedRoute(updated, PAIRING_FORM_ROUTES)) return updated;
  const routes = (state?.routes ?? []).filter((route) => route.name !== "NotFound");
  if (routes[0]?.name !== "Home") routes.unshift({ name: "Home" });
  routes.push({ name: "ConnectionsNew", params: { relayLink } });
  return { index: routes.length - 1, routes };
}

export type RelayLinkAttempt =
  | { readonly relayLink: string; readonly status: "connecting"; readonly message: string }
  | { readonly relayLink: string; readonly status: "failed"; readonly error: string };

export const relayLinkAttemptAtom = Atom.make<RelayLinkAttempt | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:relay-link-attempt"),
);

const relayLinksStarted = new Set<string>();

async function pairRelayLink(relayLink: string) {
  const stillThisLink = () => appAtomRegistry.get(relayLinkAttemptAtom)?.relayLink === relayLink;
  appAtomRegistry.set(relayLinkAttemptAtom, {
    relayLink,
    status: "connecting",
    message: t("Connecting to the computer through the Gustaf relay…"),
  });
  try {
    const [{ pairOverRelay }, { connectRelayPairing }] = await Promise.all([
      import("../relay/relayTunnels"),
      import("./relayRoute"),
    ]);
    const pairingUrl = await pairOverRelay(relayLink, (safetyCode) => {
      if (!stillThisLink()) return;
      appAtomRegistry.set(relayLinkAttemptAtom, {
        relayLink,
        status: "connecting",
        message: t(
          "Allow this phone on the computer to finish pairing. The computer shows the same safety code: {code}",
        ).replace("{code}", safetyCode),
      });
    });
    if (!stillThisLink()) return;
    const outcome = await connectRelayPairing(pairingUrl, undefined, pairEnvironment);
    if (!stillThisLink()) return;
    if (!outcome.ok) {
      relayLinksStarted.delete(relayLink);
      appAtomRegistry.set(relayLinkAttemptAtom, {
        relayLink,
        status: "failed",
        error: outcome.error ?? t("Pairing over the relay failed."),
      });
      return;
    }
    whenRootNavigationReady(() => {
      if (!stillThisLink()) return;
      appAtomRegistry.set(relayLinkAttemptAtom, null);
      const current = rootNavigationRef.getCurrentRoute()?.name;
      if (current === undefined || !PAIRING_FORM_ROUTES.includes(current)) return;
      if (!rootNavigationRef.canGoBack()) rootNavigationRef.dispatch(StackActions.replace("Home"));
      else leaveSettingsPage(rootNavigationRef, workspaceHasColumns(), "SettingsEnvironments");
    });
  } catch (error) {
    if (!stillThisLink()) return;
    relayLinksStarted.delete(relayLink);
    appAtomRegistry.set(relayLinkAttemptAtom, {
      relayLink,
      status: "failed",
      error: error instanceof Error ? error.message : t("Pairing over the relay failed."),
    });
  }
}

/** A camera QR starts the same relay pairing an in-app scan starts, once per link. */
export function startRelayPairingLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  const route = findLinkedRoute(state, PAIRING_FORM_ROUTES);
  const relayLink = (route?.params as { readonly relayLink?: unknown } | undefined)?.relayLink;
  if (typeof relayLink !== "string" || parseRelayPairingLink(relayLink) === null) return state;
  if (relayLinksStarted.has(relayLink)) return state;
  relayLinksStarted.add(relayLink);
  void pairRelayLink(relayLink);
  return state;
}

/**
 * A pairing link that lands on an open pairing form fills that form. React Navigation would push
 * `ConnectionsNew` over the Settings page's `SettingsEnvironmentNew`, stacking two copies of the
 * same form. The form keys on the link's pairing URL, so new params remount it with the prefill.
 */
export function pairingFormLinkAction(
  link: PartialState<NavigationState>,
  current: NavigationState | undefined,
) {
  const linked = findLinkedRoute(link, PAIRING_FORM_ROUTES);
  const open = current?.routes[current.index];
  if (!linked || !current || !open || !PAIRING_FORM_ROUTES.includes(open.name)) return undefined;
  return {
    ...CommonActions.replaceParams(linked.params ?? {}),
    source: open.key,
    target: current.key,
  };
}
