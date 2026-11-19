import { makeGustafRelayClient } from "@t3tools/client-runtime/gustaf-relay";
import { RelayTunnelClientError } from "@t3tools/shared/relayTunnelClient";

/**
 * Every request and socket to a `*.relay.gustaf.invalid` environment goes through here. The
 * keychain and native modules load on the first tunnel: the app runtime imports this at startup.
 */
export const gustafRelay = makeGustafRelayClient({
  getItem: async (key) => (await import("expo-secure-store")).getItemAsync(key),
  setItem: async (key, value) => (await import("expo-secure-store")).setItemAsync(key, value),
  deviceToken: async () => {
    const device = await (await import("../account/accountStorage")).loadPhoneDevice();
    if (!device) {
      throw new RelayTunnelClientError(
        "unauthorized",
        "Sign in to your Gustaf account on this phone and register it under Settings → Account.",
      );
    }
    return device.token;
  },
  native: async () => {
    const [{ getRandomBytes }, { phoneDisplayName }] = await Promise.all([
      import("expo-crypto"),
      import("../account/useAccount"),
    ]);
    return { name: phoneDisplayName(), randomBytes: (length: number) => getRandomBytes(length) };
  },
});

export const relayTunnels = gustafRelay.tunnels;
