import {
  generateNoiseKeyPair,
  noiseKeyPairFromSecret,
  relaySafetyCode,
} from "@t3tools/shared/relayNoise";
import {
  type RelayPairingOffer,
  fromBase64Url,
  parseRelayPairingLink,
  toBase64Url,
} from "@t3tools/shared/relayTunnel";
import {
  type RelayTunnelClientOptions,
  RelayTunnelClient,
  RelayTunnelClientError,
  RelayTunnelPool,
  relayVirtualBaseUrl,
} from "@t3tools/shared/relayTunnelClient";

/**
 * The client side of the Gustaf relay (not T3 Connect): this device's Noise key, the computers it
 * paired with, and the tunnels to them. The phone and the desktop app supply storage and keys.
 */
export interface GustafRelayPlatform {
  /** Durable secret storage: the keychain on a phone, the shell's encrypted account file on desktop. */
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  /** This device's own cloud credential; rejects with a `RelayTunnelClientError` when unregistered. */
  readonly deviceToken: () => Promise<string>;
  /** The name computers show for this device and a secure random source. */
  readonly native: () => Promise<{
    readonly name: string;
    readonly randomBytes: (length: number) => Uint8Array;
  }>;
  readonly createSocket?: (url: string) => WebSocket;
}

// Storage keys predate the desktop client; the phone keeps its existing key and computers.
export const RELAY_CLIENT_KEY_STORAGE = "gustaf.relay.phone-key";
export const RELAY_HOSTS_STORAGE = "gustaf.relay.hosts";

interface RelayHostRecord {
  readonly relayUrl: string;
  readonly hostKey: string;
  readonly hostName: string;
}

export const isRelayPairingLink = (value: string) => parseRelayPairingLink(value) !== null;

export function makeGustafRelayClient(platform: GustafRelayPlatform) {
  const keyPair = async () => {
    const stored = await platform.getItem(RELAY_CLIENT_KEY_STORAGE);
    if (stored) return noiseKeyPairFromSecret(fromBase64Url(stored));
    const created = generateNoiseKeyPair((await platform.native()).randomBytes);
    await platform.setItem(RELAY_CLIENT_KEY_STORAGE, toBase64Url(created.secretKey));
    return created;
  };

  const loadHosts = async (): Promise<Record<string, RelayHostRecord>> => {
    const raw = await platform.getItem(RELAY_HOSTS_STORAGE);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, RelayHostRecord>;
    } catch {
      return {};
    }
  };

  const saveHost = async (offer: RelayPairingOffer) => {
    const hosts = await loadHosts();
    hosts[offer.hostDeviceId.toLowerCase()] = {
      relayUrl: offer.relayUrl,
      hostKey: offer.hostKey,
      hostName: offer.hostName,
    };
    await platform.setItem(RELAY_HOSTS_STORAGE, JSON.stringify(hosts));
  };

  const optionsFor = async (hostDeviceId: string): Promise<RelayTunnelClientOptions> => {
    const [deviceToken, clientKeyPair, hosts, native] = await Promise.all([
      platform.deviceToken(),
      keyPair(),
      loadHosts(),
      platform.native(),
    ]);
    const host = hosts[hostDeviceId];
    if (!host)
      throw new RelayTunnelClientError(
        "unauthorized",
        "This computer was not paired over the relay.",
      );
    return {
      relayUrl: host.relayUrl,
      deviceToken,
      hostDeviceId,
      hostKey: host.hostKey,
      clientKeyPair,
      ...native,
      ...(platform.createSocket ? { createSocket: platform.createSocket } : {}),
    };
  };

  /** Every request and socket to a `*.relay.gustaf.invalid` environment goes through here. */
  const tunnels = new RelayTunnelPool(optionsFor);

  return {
    tunnels,

    /**
     * Relay pairing link → the computer's approval → an ordinary pairing link at the computer's
     * virtual relay origin, which the normal pairing flow redeems through the tunnel.
     */
    async pair(
      link: string,
      /** Called with the code the computer shows beside "Allow …?". */
      onPending: (safetyCode: string) => void,
    ): Promise<string> {
      const offer = parseRelayPairingLink(link);
      if (!offer) throw new Error("This is not a Gustaf relay code.");
      const [deviceToken, clientKeyPair, native] = await Promise.all([
        platform.deviceToken(),
        keyPair(),
        platform.native(),
      ]);
      const client = await RelayTunnelClient.connect({
        relayUrl: offer.relayUrl,
        deviceToken,
        hostDeviceId: offer.hostDeviceId,
        hostKey: offer.hostKey,
        clientKeyPair,
        ...native,
        ...(platform.createSocket ? { createSocket: platform.createSocket } : {}),
        pairingSecret: offer.secret,
        onPending: () =>
          onPending(relaySafetyCode(clientKeyPair.publicKey, fromBase64Url(offer.hostKey))),
      });
      const token = client.pairingToken;
      client.close();
      if (!token)
        throw new Error("The computer did not send a pairing code. Show a new code and try again.");
      await saveHost(offer);
      tunnels.forget(offer.hostDeviceId.toLowerCase());
      return `${relayVirtualBaseUrl(offer.hostDeviceId)}/pair#token=${encodeURIComponent(token)}`;
    },

    /** The code this device and a relay-paired computer both show; null when not paired here. */
    async safetyCodeFor(hostDeviceId: string): Promise<string | null> {
      const [hosts, pair] = await Promise.all([loadHosts(), keyPair()]);
      const host = hosts[hostDeviceId];
      return host ? relaySafetyCode(pair.publicKey, fromBase64Url(host.hostKey)) : null;
    },
  };
}

export type GustafRelayClient = ReturnType<typeof makeGustafRelayClient>;
