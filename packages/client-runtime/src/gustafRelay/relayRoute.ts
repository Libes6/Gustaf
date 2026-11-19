import type { EnvironmentId } from "@t3tools/contracts";

export interface RelayPairingOutcome {
  readonly ok: boolean;
  readonly alreadySaved?: { readonly environmentId: EnvironmentId };
}

/**
 * A relay pairing link always means "reach this computer through the relay", so a computer
 * already saved another way gets the relay as one more route instead of an error. The duplicate
 * check runs before the code is redeemed, so the same link works twice.
 */
export async function connectRelayPairing<Outcome extends RelayPairingOutcome>(
  pairingUrl: string,
  routeFor: EnvironmentId | undefined,
  connect: (pairingUrl: string, environmentId: EnvironmentId | undefined) => Promise<Outcome>,
): Promise<Outcome> {
  const outcome = await connect(pairingUrl, routeFor);
  return !outcome.ok && routeFor === undefined && outcome.alreadySaved !== undefined
    ? connect(pairingUrl, outcome.alreadySaved.environmentId)
    : outcome;
}
