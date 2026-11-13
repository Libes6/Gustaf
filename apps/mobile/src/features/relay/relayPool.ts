import { RelayTunnelPool } from "@t3tools/shared/relayTunnelClient";

/**
 * Every request and socket to a `*.relay.gustaf.invalid` environment goes through here. The
 * keychain and native modules load on the first tunnel: the app runtime imports this at startup.
 */
export const relayTunnels = new RelayTunnelPool(async (hostDeviceId) =>
  (await import("./relayTunnels")).relayClientOptions(hostDeviceId),
);
