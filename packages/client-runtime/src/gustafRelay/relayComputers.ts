// @effect-diagnostics globalTimers:off -- A plain fetch for React Native and the browser, outside any Effect runtime.
import type { EnvironmentId } from "@t3tools/contracts";
import { type RelayComputer, parseRelayComputers } from "@t3tools/shared/relayComputers";
import { RelayTunnelClientError, relayHostFromUrl } from "@t3tools/shared/relayTunnelClient";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { connectionRoutes, routeHttpBaseUrl } from "../connection/routes.ts";
import { type RelayPairingOutcome, connectRelayPairing } from "./relayRoute.ts";

export type { RelayComputer };

const COMPUTERS_TIMEOUT_MS = 10_000;

export interface RelayComputersResult {
  readonly computers: ReadonlyArray<RelayComputer>;
  /** Why the list is empty or short: this device is signed out, or the relay did not answer. */
  readonly problem?: "signed_out" | "unavailable";
}

/**
 * The account's computers as the relay lists them for this device's own credential
 * (`GET /v1/relay/hosts`), without the computer asking (`selfDeviceId`).
 */
export async function fetchRelayComputers(input: {
  readonly relayUrl: string;
  readonly deviceToken: string;
  readonly selfDeviceId?: string | null;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): Promise<RelayComputersResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMPUTERS_TIMEOUT_MS);
  const cancel = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const response = await (input.fetch ?? fetch)(new URL("/v1/relay/hosts", input.relayUrl), {
      headers: { accept: "application/json", authorization: `Bearer ${input.deviceToken}` },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403)
      return { computers: [], problem: "signed_out" };
    if (!response.ok) return { computers: [], problem: "unavailable" };
    return {
      computers: parseRelayComputers(await response.json()).filter(
        (computer) => computer.deviceId !== input.selfDeviceId,
      ),
    };
  } catch {
    return { computers: [], problem: "unavailable" };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
  }
}

/** The computers a saved environment already reaches through the Gustaf relay. */
export function relayComputersOfEnvironments(
  entries: ReadonlyArray<ConnectionCatalogEntry>,
): ReadonlySet<string> {
  const connected = new Set<string>();
  for (const entry of entries) {
    for (const route of connectionRoutes(entry)) {
      const url = routeHttpBaseUrl(route);
      const device = url === null ? null : relayHostFromUrl(url);
      if (device !== null) connected.add(device);
    }
  }
  return connected;
}

/**
 * The computers worth offering: those not saved here yet, online ones first (they are the ones a
 * tap can reach), each group by name.
 */
export function pickableRelayComputers(
  computers: ReadonlyArray<RelayComputer>,
  connected: ReadonlySet<string>,
): ReadonlyArray<RelayComputer> {
  return computers
    .filter((computer) => !connected.has(computer.deviceId.toLowerCase()))
    .sort(
      (left, right) =>
        Number(right.online) - Number(left.online) || left.name.localeCompare(right.name),
    );
}

/** What a user can do about a failed pairing from the account's computer list, naming the computer. */
export function relayPairingFailureMessage(
  error: unknown,
  computerName: string,
  resolve: MFunctionType = mFallback,
): string {
  const name = computerName;
  if (!(error instanceof RelayTunnelClientError)) {
    return resolve(msg("Pairing over the relay failed."));
  }
  switch (error.reason) {
    case "host_offline":
      return resolve(
        msg(
          "{name} is not connected to the Gustaf relay. Open Gustaf there and check that it is signed in to the same Gustaf account as this device.",
          { name },
        ),
      );
    case "unauthorized":
      return resolve(
        msg(
          "This device is not signed in to the Gustaf relay, or its sign-in no longer works. Sign in again under Settings → Account.",
        ),
      );
    case "limit":
      return resolve(
        msg(
          "The Gustaf relay limit for your account is reached: too many open connections, or this month's traffic is used up.",
        ),
      );
    case "rejected":
      return resolve(
        msg(
          "{name} did not allow this device: it was declined there, or nobody answered in time.",
          {
            name,
          },
        ),
      );
    case "busy":
      return resolve(
        msg("{name} already has requests waiting. Answer them there, then try again.", { name }),
      );
    case "unknown_device":
    case "linking_off":
      return resolve(
        msg(
          "{name} runs a Gustaf version that cannot pair from your account's computer list. Update Gustaf there, or use the QR code under Settings → Sharing & access.",
          { name },
        ),
      );
    case "policy":
      return resolve(msg("{name}'s managed policy does not allow new devices.", { name }));
    case "handshake_failed":
      return resolve(msg("The secure connection to {name} failed. Try again.", { name }));
    case "relay_unreachable":
      return resolve(msg("The Gustaf relay did not answer."));
    case "closed":
      return resolve(
        msg("The connection to {name} through the Gustaf relay closed. Try again.", { name }),
      );
  }
}

export type RelayComputerPairingResult =
  | { readonly status: "paired" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly message: string };

/**
 * Pairs with one of the account's computers: the computer asks its user (who sees the same safety
 * code `onPending` gets), then the pairing is redeemed through the tunnel like a scanned link.
 */
export async function pairWithRelayComputer<
  Outcome extends RelayPairingOutcome & { readonly error: string | null },
>(input: {
  readonly relay: {
    readonly pairWithComputer: (
      computer: { readonly deviceId: string; readonly name: string },
      onPending: (safetyCode: string) => void,
      signal?: AbortSignal,
    ) => Promise<string>;
  };
  readonly computer: { readonly deviceId: string; readonly name: string };
  readonly routeFor: EnvironmentId | undefined;
  readonly connect: (
    pairingUrl: string,
    environmentId: EnvironmentId | undefined,
  ) => Promise<Outcome>;
  readonly onPending: (safetyCode: string) => void;
  readonly signal?: AbortSignal;
  readonly resolve?: MFunctionType;
}): Promise<RelayComputerPairingResult> {
  const resolve = input.resolve ?? mFallback;
  let pairingUrl: string;
  try {
    pairingUrl = await input.relay.pairWithComputer(input.computer, input.onPending, input.signal);
  } catch (error) {
    return input.signal?.aborted === true
      ? { status: "cancelled" }
      : {
          status: "failed",
          message: relayPairingFailureMessage(error, input.computer.name, resolve),
        };
  }
  if (input.signal?.aborted === true) return { status: "cancelled" };
  const outcome = await connectRelayPairing(pairingUrl, input.routeFor, input.connect);
  return outcome.ok
    ? { status: "paired" }
    : {
        status: "failed",
        message: outcome.error ?? resolve(msg("Pairing over the relay failed.")),
      };
}

/** What a pairing from the account's computers shows while it runs; `idle` once it ended. */
export type RelayPairingProgress =
  | { readonly phase: "idle" }
  | { readonly phase: "connecting"; readonly computer: RelayComputer }
  | {
      readonly phase: "waiting";
      readonly computer: RelayComputer;
      /** Shown on the computer too: matching codes rule out a relay in the middle. */
      readonly safetyCode: string;
    }
  | { readonly phase: "failed"; readonly computer: RelayComputer; readonly message: string };

export const RELAY_PAIRING_IDLE: RelayPairingProgress = { phase: "idle" };

/**
 * Starts a pairing with `computer` and reports each step to `onProgress`. `cancel` ends the
 * attempt while the computer waits for its user; the computer then drops the request.
 */
export function startRelayComputerPairing<
  Outcome extends RelayPairingOutcome & { readonly error: string | null },
>(
  input: Omit<Parameters<typeof pairWithRelayComputer<Outcome>>[0], "signal" | "onPending"> & {
    readonly computer: RelayComputer;
    readonly onProgress: (progress: RelayPairingProgress) => void;
  },
): { readonly cancel: () => void; readonly done: Promise<RelayComputerPairingResult> } {
  const controller = new AbortController();
  const { onProgress, computer } = input;
  onProgress({ phase: "connecting", computer });
  const done = pairWithRelayComputer({
    ...input,
    signal: controller.signal,
    onPending: (safetyCode) => onProgress({ phase: "waiting", computer, safetyCode }),
  }).then((result) => {
    onProgress(
      result.status === "failed"
        ? { phase: "failed", computer, message: result.message }
        : RELAY_PAIRING_IDLE,
    );
    return result;
  });
  return { cancel: () => controller.abort(), done };
}
