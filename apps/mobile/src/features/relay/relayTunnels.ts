import { gustafRelay } from "./relayPool";

export { isRelayPairingLink } from "@t3tools/client-runtime/gustaf-relay";

/**
 * Scanned relay QR code → the computer's approval → an ordinary pairing link at the computer's
 * virtual relay origin, which the normal pairing flow redeems through the tunnel.
 */
export const pairOverRelay = (link: string, onPending: (safetyCode: string) => void) =>
  gustafRelay.pair(link, onPending);

/** The code this phone and a relay-paired computer both show; null when it was not paired here. */
export const relaySafetyCodeFor = (hostDeviceId: string) => gustafRelay.safetyCodeFor(hostDeviceId);
