import {
  generateNoiseKeyPair,
  noiseKeyPairFromSecret,
  relaySafetyCode,
} from "@t3tools/shared/relayNoise";
import { fromBase64Url, parseRelayPairingLink, toBase64Url } from "@t3tools/shared/relayTunnel";
import {
  type RelayTunnelClientOptions,
  RelayTunnelClient,
  RelayTunnelClientError,
  RelayTunnelPool,
  relayVirtualBaseUrl,
} from "@t3tools/shared/relayTunnelClient";

import { type RelayComputersResult, fetchRelayComputers } from "./relayComputers.ts";

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
  /** The cloud API's origin this device signs in to, which also hosts the relay. */
  readonly relayUrl: () => Promise<string>;
  /** This device's own id among the account's computers, so the list never offers it to itself. */
  readonly selfDeviceId?: () => Promise<string | null>;
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

  const saveHost = async (host: RelayHostRecord & { readonly hostDeviceId: string }) => {
    const hosts = await loadHosts();
    hosts[host.hostDeviceId.toLowerCase()] = {
      relayUrl: host.relayUrl,
      hostKey: host.hostKey,
      hostName: host.hostName,
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

    /** The account's other computers, as the relay lists them for this device. */
    async computers(signal?: AbortSignal): Promise<RelayComputersResult> {
      let credentials: { readonly deviceToken: string; readonly relayUrl: string };
      try {
        const [deviceToken, relayUrl] = await Promise.all([
          platform.deviceToken(),
          platform.relayUrl(),
        ]);
        credentials = { deviceToken, relayUrl };
      } catch {
        return { computers: [], problem: "signed_out" };
      }
      return fetchRelayComputers({
        ...credentials,
        selfDeviceId: (await platform.selfDeviceId?.()) ?? null,
        ...(signal ? { signal } : {}),
      });
    },

    /**
     * Picks a computer from the account's list instead of scanning its QR code: its user is
     * asked, and sees the same safety code `onPending` gets. The computer's key is taken on first
     * use, so that code is the only check against a relay in the middle. Resolves with the
     * ordinary pairing link at the computer's virtual relay origin, as `pair` does.
     */
    async pairWithComputer(
      computer: { readonly deviceId: string; readonly name: string },
      onPending: (safetyCode: string) => void,
      signal?: AbortSignal,
    ): Promise<string> {
      const [deviceToken, relayUrl, clientKeyPair, native] = await Promise.all([
        platform.deviceToken(),
        platform.relayUrl(),
        keyPair(),
        platform.native(),
      ]);
      const client = await RelayTunnelClient.connect({
        relayUrl,
        deviceToken,
        hostDeviceId: computer.deviceId,
        hostKey: null,
        clientKeyPair,
        ...native,
        ...(platform.createSocket ? { createSocket: platform.createSocket } : {}),
        accountPairing: true,
        ...(signal ? { signal } : {}),
        onPending: (hostKey) => onPending(relaySafetyCode(clientKeyPair.publicKey, hostKey)),
      });
      const token = client.pairingToken;
      const hostKey = toBase64Url(client.remoteStaticKey);
      client.close();
      // A computer from before this pairing answers a known device with no code at all.
      if (!token) {
        throw new RelayTunnelClientError(
          "unknown_device",
          "The computer did not send a pairing code.",
        );
      }
      await saveHost({
        relayUrl,
        hostDeviceId: computer.deviceId,
        hostKey,
        hostName: computer.name,
      });
      tunnels.forget(computer.deviceId.toLowerCase());
      return `${relayVirtualBaseUrl(computer.deviceId)}/pair#token=${encodeURIComponent(token)}`;
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
