import { makeGustafRelayClient } from "@t3tools/client-runtime/gustaf-relay";
import { RelayTunnelClientError } from "@t3tools/shared/relayTunnelClient";

import { shellAccount } from "../shellAccount";

/**
 * The desktop app reaches computers paired over the Gustaf relay through this client. The shell
 * keeps the device credential and the client's key in its encrypted account file; outside the
 * desktop app there is none, and the browser web client has no relay route.
 */
function makeDesktopRelay() {
  const relayClient = shellAccount()?.relayClient;
  if (!relayClient) return null;
  return makeGustafRelayClient({
    getItem: (key) => relayClient.getItem(key),
    setItem: (key, value) => relayClient.setItem(key, value),
    deviceToken: async () => {
      try {
        return (await relayClient.credential()).deviceToken;
      } catch (error) {
        throw new RelayTunnelClientError(
          "unauthorized",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    native: async () => ({
      name: (await relayClient.credential()).deviceName,
      randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
    }),
  });
}

export const desktopRelay = makeDesktopRelay();
