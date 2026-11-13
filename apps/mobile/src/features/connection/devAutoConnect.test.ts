import * as NodeModule from "node:module";
import type { NavigationState, PartialState } from "@react-navigation/native";
import { formatRelayPairingLink } from "@t3tools/shared/relayTunnel";
import { expect, it, vi } from "vite-plus/test";

const requireFromNative = NodeModule.createRequire(
  NodeModule.createRequire(import.meta.url).resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { getActionFromState, getStateFromPath } = requireFromNative("@react-navigation/core") as {
  readonly getActionFromState: typeof import("@react-navigation/native").getActionFromState;
  readonly getStateFromPath: typeof import("@react-navigation/native").getStateFromPath;
};
const { StackRouter } = requireFromCore("@react-navigation/routers") as {
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};

const harness = vi.hoisted(() => ({
  pair: vi.fn(),
  relay: vi.fn(),
  goBack: vi.fn(),
  dispatch: vi.fn(),
  columns: false,
  // The root stack the form sits on when pairing succeeds.
  rootState: {
    key: "root",
    index: 2,
    routes: [
      { key: "home", name: "Home" },
      { key: "settings", name: "Settings" },
      { key: "new", name: "SettingsEnvironmentNew" },
    ],
  },
  // Navigation that is not ready yet holds callbacks here until the test flushes them.
  deferred: null as Array<() => void> | null,
}));

vi.mock("../relay/relayTunnels", () => ({ pairOverRelay: harness.relay }));

vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: vi.fn() },
  CommonActions: {
    replaceParams: (params: object) => ({ type: "REPLACE_PARAMS", payload: { params } }),
  },
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  pairEnvironment: harness.pair,
}));
vi.mock("../layout/workspace/workspace-selection-store", () => ({
  workspaceHasColumns: () => harness.columns,
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {
    getCurrentRoute: () => harness.rootState.routes[harness.rootState.index],
    getRootState: () => harness.rootState,
    getState: () => harness.rootState,
    getParent: () => undefined,
    canGoBack: () => true,
    goBack: harness.goBack,
    dispatch: harness.dispatch,
  },
  whenRootNavigationReady: (navigate: () => void) => {
    if (harness.deferred) harness.deferred.push(navigate);
    else navigate();
  },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import {
  autoConnectReport,
  devAutoConnectAttemptAtom,
  pairingFormLinkAction,
  relayPairingLinkFromPath,
  startDevAutoConnect,
  takeRelayPairingLink,
  startRelayPairingLink,
  relayLinkAttemptAtom,
} from "./devAutoConnect";

const PAIRING_URL = "http://192.168.1.10:3773/pair#token=abc";

function settingsLink(params: object): PartialState<NavigationState> {
  return {
    routes: [
      { name: "Home" },
      { name: "Settings", state: { routes: [{ name: "SettingsEnvironmentNew", params }] } },
    ],
  };
}

it("pairs from a nested settings link once, reports failure, and closes the form on success", async () => {
  vi.stubGlobal("__DEV__", true);
  const failed = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(failed.promise);

  const state = settingsLink({ pairingUrl: ` ${PAIRING_URL} `, autoConnect: "1" });
  expect(startDevAutoConnect(state)).toBe(state);
  expect(harness.pair).toHaveBeenCalledExactlyOnceWith(PAIRING_URL);
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toEqual({
    pairingUrl: PAIRING_URL,
    status: "connecting",
  });

  failed.resolve({ ok: false, error: "Pairing code expired." });
  await failed.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toEqual({
    pairingUrl: PAIRING_URL,
    status: "failed",
    error: "Pairing code expired.",
  });
  expect(harness.goBack).not.toHaveBeenCalled();

  const succeeded = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(succeeded.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "true" }));
  succeeded.resolve({ ok: true, error: null });
  await succeeded.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
  expect(harness.goBack).toHaveBeenCalledOnce();
});

it("only prefills without the flag, and ignores the flag in production builds", () => {
  harness.pair.mockClear();
  vi.stubGlobal("__DEV__", true);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));
  vi.stubGlobal("__DEV__", false);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  expect(harness.pair).not.toHaveBeenCalled();
});

it("forgets a failed auto-connect once the form is opened again without the flag", async () => {
  vi.stubGlobal("__DEV__", true);
  const failed = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(failed.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  failed.resolve({ ok: false, error: "Pairing code expired." });
  await failed.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toMatchObject({ status: "failed" });

  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
});

it("drops the result of a pairing that a later link superseded", async () => {
  vi.stubGlobal("__DEV__", true);
  const stale = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(stale.promise);
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  startDevAutoConnect(settingsLink({ pairingUrl: PAIRING_URL }));

  stale.resolve({ ok: false, error: "Pairing code expired." });
  await stale.promise;
  await Promise.resolve();
  expect(appAtomRegistry.get(devAutoConnectAttemptAtom)).toBeNull();
});

it("keeps Connect busy while the auto-connect runs, even after the user edits the form", () => {
  const connecting = { pairingUrl: PAIRING_URL, status: "connecting" } as const;
  expect(autoConnectReport(connecting, PAIRING_URL, true)).toEqual({
    connecting: true,
    error: null,
  });
  const failed = { pairingUrl: PAIRING_URL, status: "failed", error: "Expired." } as const;
  expect(autoConnectReport(failed, PAIRING_URL, false)).toEqual({
    connecting: false,
    error: "Expired.",
  });
  expect(autoConnectReport(failed, PAIRING_URL, true).error).toBeNull();
  expect(autoConnectReport(connecting, "http://other/pair#token=x", false).connecting).toBe(false);
});

async function pairSuccessfully(link: PartialState<NavigationState>) {
  const succeeded = Promise.withResolvers<{ ok: boolean; error: string | null }>();
  harness.pair.mockReturnValueOnce(succeeded.promise);
  startDevAutoConnect(link);
  succeeded.resolve({ ok: true, error: null });
  await succeeded.promise;
  await Promise.resolve();
}

it("on columns, a successful settings link shows Environments instead of an empty detail", async () => {
  vi.stubGlobal("__DEV__", true);
  harness.goBack.mockClear();
  harness.dispatch.mockClear();
  harness.columns = true;
  await pairSuccessfully(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  harness.columns = false;

  expect(harness.goBack).not.toHaveBeenCalled();
  expect(harness.dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "RESET",
    target: "root",
    payload: expect.objectContaining({
      index: 2,
      routes: [
        { key: "home", name: "Home" },
        { key: "settings", name: "Settings" },
        { name: "SettingsEnvironments", params: undefined },
      ],
    }),
  });
});

it("a success that waited for navigation leaves a newer link's form open", async () => {
  vi.stubGlobal("__DEV__", true);
  harness.goBack.mockClear();
  harness.dispatch.mockClear();
  harness.deferred = [];
  await pairSuccessfully(settingsLink({ pairingUrl: PAIRING_URL, autoConnect: "1" }));
  startDevAutoConnect(settingsLink({ pairingUrl: "http://192.168.1.11:3773/pair#token=def" }));

  const deferred = harness.deferred;
  harness.deferred = null;
  for (const navigate of deferred) navigate();
  expect(harness.goBack).not.toHaveBeenCalled();
  expect(harness.dispatch).not.toHaveBeenCalled();
});

it("a pairing link fills the pairing form already on screen instead of stacking a second one", () => {
  const linking = {
    initialRouteName: "Home",
    screens: {
      Home: "",
      Settings: "settings",
      SettingsEnvironmentNew: "settings/environment-new",
      ConnectionsNew: "connections/new",
    },
  };
  const router = StackRouter({});
  const options = {
    routeNames: Object.keys(linking.screens),
    routeParamList: {},
    routeGetIdList: {},
  };
  // Settings > Environments > Add environment, as the user opened it.
  const open = router.getRehydratedState(
    {
      index: 2,
      routes: [{ name: "Home" }, { name: "Settings" }, { name: "SettingsEnvironmentNew" }],
    },
    options,
  );
  const link = getStateFromPath(
    `connections/new?pairingUrl=${encodeURIComponent(PAIRING_URL)}`,
    linking,
  )!;
  const action = pairingFormLinkAction(link, open) ?? getActionFromState(link, linking)!;
  const next = router.getStateForAction(open, { target: open.key, ...action }, options);

  expect(next?.routes.map((route) => route.name)).toEqual([
    "Home",
    "Settings",
    "SettingsEnvironmentNew",
  ]);
  expect(next?.routes.at(-1)).toMatchObject({
    key: open.routes[2]!.key,
    params: { pairingUrl: PAIRING_URL },
  });
});

const RELAY_LINK = formatRelayPairingLink({
  relayUrl: "https://api.libes6.ru",
  hostDeviceId: "host1",
  hostKey: "A".repeat(43),
  secret: "b".repeat(43),
  hostName: "Desk",
});
const RELAY_QUERY = RELAY_LINK.slice("gustaf://relay-pair".length);

it("a relay QR opened from the camera lands on the add-route form with the link", () => {
  const linking = {
    initialRouteName: "Home",
    screens: {
      Home: "",
      ConnectionsNew: { path: "connections/new", alias: ["relay-pair"] },
      NotFound: "*",
    },
  };
  for (const scheme of ["", "gustaf://", "gustaf-dev://", "gustaf-preview://"]) {
    expect(relayPairingLinkFromPath(`${scheme}relay-pair${RELAY_QUERY}`)).toBe(RELAY_LINK);
  }
  expect(relayPairingLinkFromPath("relay-pair?v=0")).toBeNull();

  const path = `relay-pair${RELAY_QUERY}`;
  const state = takeRelayPairingLink(getStateFromPath(path, linking), path);
  expect(state?.routes).toMatchObject([
    { name: "Home" },
    { name: "ConnectionsNew", params: { relayLink: RELAY_LINK } },
  ]);
});

function relayCompletion() {
  const done = Promise.withResolvers<void>();
  const unsubscribe = appAtomRegistry.subscribe(relayLinkAttemptAtom, (attempt) => {
    if (attempt === null || attempt.status === "failed") done.resolve();
  });
  return { done: done.promise, [Symbol.dispose]: unsubscribe };
}

it.each(["gustaf://", "gustaf-dev://", "gustaf-preview://"])(
  "%s starts relay pairing at link time, once per link, and closes the form on success",
  async (scheme) => {
    harness.columns = false;
    harness.deferred = null;
    harness.goBack.mockClear();
    harness.relay.mockClear();
    harness.pair.mockClear();
    const link = formatRelayPairingLink({
      relayUrl: "https://api.libes6.ru",
      hostDeviceId: scheme.replace(/[^a-z]/g, ""),
      hostKey: "A".repeat(43),
      secret: "c".repeat(43),
      hostName: "Desk",
    });
    const entered = Promise.withResolvers<void>();
    const paired = Promise.withResolvers<string>();
    harness.relay.mockImplementationOnce(() => {
      entered.resolve();
      return paired.promise;
    });
    harness.pair.mockResolvedValueOnce({ ok: true, error: null });
    const state = takeRelayPairingLink(undefined, link.replace("gustaf://", scheme));
    expect(startRelayPairingLink(state)).toBe(state);
    await entered.promise;
    expect(appAtomRegistry.get(relayLinkAttemptAtom)).toMatchObject({
      relayLink: link,
      status: "connecting",
    });
    startRelayPairingLink(state);
    expect(harness.relay).toHaveBeenCalledTimes(1);
    using completion = relayCompletion();
    paired.resolve(PAIRING_URL);
    await completion.done;
    expect(harness.pair).toHaveBeenCalledExactlyOnceWith(PAIRING_URL, undefined);
    expect(appAtomRegistry.get(relayLinkAttemptAtom)).toBeNull();
    expect(harness.goBack).toHaveBeenCalledOnce();
    startRelayPairingLink(state);
    expect(harness.relay).toHaveBeenCalledTimes(1);
  },
);

it.each(["relay", "pairing"])(
  "exposes an expired link error from %s and leaves the form open",
  async (stage) => {
    harness.goBack.mockClear();
    const link = formatRelayPairingLink({
      relayUrl: "https://api.libes6.ru",
      hostDeviceId: `expired-${stage}`,
      hostKey: "A".repeat(43),
      secret: "d".repeat(43),
      hostName: "MacBook",
    });
    const error = "Pairing code expired.";
    if (stage === "relay") harness.relay.mockRejectedValueOnce(new Error(error));
    else {
      harness.relay.mockResolvedValueOnce(PAIRING_URL);
      harness.pair.mockResolvedValueOnce({ ok: false, error });
    }
    const state = takeRelayPairingLink(undefined, link);
    startRelayPairingLink(state);
    using completion = relayCompletion();
    await completion.done;
    expect(appAtomRegistry.get(relayLinkAttemptAtom)).toEqual({
      relayLink: link,
      status: "failed",
      error,
    });
    expect(harness.goBack).not.toHaveBeenCalled();
  },
);

it("ignores a malformed relay link without starting a pairing", () => {
  harness.relay.mockClear();
  const state = settingsLink({ relayLink: "gustaf://relay-pair?v=0" });
  expect(startRelayPairingLink(state)).toBe(state);
  expect(takeRelayPairingLink(undefined, "gustaf://relay-pair?v=0")).toBeUndefined();
  expect(harness.relay).not.toHaveBeenCalled();
});
