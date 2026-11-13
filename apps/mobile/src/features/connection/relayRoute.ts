import type { EnvironmentId } from "@t3tools/contracts";

import type { PairingOutcome } from "../../state/use-remote-environment-registry";

/**
 * A relay QR code always means "reach this computer through the relay", so a computer the
 * phone already saved another way gets the relay as one more route instead of an error.
 * The duplicate check runs before the code is redeemed, so the same link works twice.
 */
export async function connectRelayPairing(
  pairingUrl: string,
  routeFor: EnvironmentId | undefined,
  connect: (
    pairingUrl: string,
    environmentId: EnvironmentId | undefined,
  ) => Promise<PairingOutcome>,
): Promise<PairingOutcome> {
  const outcome = await connect(pairingUrl, routeFor);
  return !outcome.ok && routeFor === undefined && outcome.alreadySaved !== undefined
    ? connect(pairingUrl, outcome.alreadySaved.environmentId)
    : outcome;
}
